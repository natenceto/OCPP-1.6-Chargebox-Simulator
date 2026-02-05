(function () {
  'use strict';

  // Simulator state
  let msgCounter = 0;
  let heartbeatIntervalId = null;
  const POSSIBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const SIMULATOR_VERSION = '0.9.1';
  let id = '';
  let _websocket = null;
  let connectorLocked = false;

  // Simulator configuration
  let SIM_NUMBER_OF_CONNECTORS = 1;
  let SIM_MV_SAMPLE_INTERVAL_MS = 1000; // 1s default
  let SIM_HEARTBEAT_INTERVAL_MS = 60000; // 60s default
  let mvLoopIntervalId = null;
  let dataTransferLoopId = null;

  // Transaction and SoC state
  let localTxCounter = 1000; // local transaction id generator
  let currentTransactionId = null;
  let currentSoC = 25;

  function randomId() {
    let r = '';
    for (let i = 0; i < 36; i++) {
      r += POSSIBLE_CHARS.charAt(Math.floor(Math.random() * POSSIBLE_CHARS.length));
    }
    id = r;
    return id;
  }

  function logMsg(msg) {
    console.log(msg);
    $('#messages').append('<li>' + msg + '</li>');
    $('#console').scrollTop($('#console').prop('scrollHeight'));
  }

  function isWebSocketOpen() {
    return !!(_websocket && _websocket.readyState === WebSocket.OPEN);
  }

  function safeSend(message) {
    if (!isWebSocketOpen()) {
      logMsg('WebSocket not connected!');
      return;
    }

    // Try to parse the message and sanitize StatusNotification payloads to avoid server FormatViolation
    try {
      let parsed = typeof message === 'string' ? JSON.parse(message) : message;
      if (Array.isArray(parsed) && parsed.length >= 3) {
        const action = parsed[2];
        if (action === 'StatusNotification') {
          // Allowed fields for StatusNotification per OCPP 1.6
          const allowed = ['connectorId', 'status', 'errorCode', 'info', 'timestamp'];
          const payload = parsed[3] || {};
          const sanitized = {};
          allowed.forEach(k => {
            if (Object.prototype.hasOwnProperty.call(payload, k)) sanitized[k] = payload[k];
          });
          // Rebuild message with sanitized payload
          parsed = [parsed[0], parsed[1], action, sanitized];
          message = JSON.stringify(parsed);
          logMsg('Sanitized StatusNotification payload before send');
        }
      }
    } catch (e) {
      // If JSON parse fails, just send the original message
    }

    _websocket.send(message);
  }

  function wsConnect() {
    // Reset local state for a fresh connect
    msgCounter = 0;
    if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }

    const CP = $('#CP').val();
    logMsg('Attempting to connect to: ' + CP);

    if (_websocket) {
      $('#red').show();
      _websocket.close(3001);
      return;
    }

    _websocket = new WebSocket(CP, ['ocpp1.6', 'ocpp1.5']);

    _websocket.onopen = function () {
      logMsg('WebSocket connected');
      sessionStorage.setItem('LastAction', 'BootNotification');
      $('#blue').show();
      BootNotification();
      $('#connect').text('Disconnect').css('background', 'green');
    };

    _websocket.onmessage = function (evt) {
      msgCounter++;
      let ddata;
      try { ddata = JSON.parse(evt.data); } catch (e) { logMsg('Invalid JSON received'); return; }
      console.log('Received message:', ddata);

      // Handle CallResult (3, uniqueId, payload) and CallError (4, uniqueId, ...)
      if (ddata[0] === 3) {
        const lastAction = sessionStorage.getItem('LastAction');
        if (lastAction === 'BootNotification') {
          const hb = (ddata[2] && ddata[2].interval) ? Number(ddata[2].interval) : (SIM_HEARTBEAT_INTERVAL_MS / 1000);
          startHB(hb * 1000);
          setTimeout(send_initial_status_for_connectors, 200);
        }

        if (lastAction === 'startTransaction') {
          const txId = (ddata[2] && ddata[2].transactionId) ? Number(ddata[2].transactionId) : null;
          if (!txId || txId === 0) {
            // Fallback to locally generated transaction id to behave like a real station
            currentTransactionId = currentTransactionId || (++localTxCounter);
            $('#transactionId').val(currentTransactionId);
            logMsg('StartTransaction response invalid from server; using local transaction id ' + currentTransactionId);
          } else {
            currentTransactionId = txId;
            $('#transactionId').val(currentTransactionId);
            logMsg('TransactionId assigned by server: ' + currentTransactionId);
          }
        }

        if (lastAction === 'stopTransaction') {
          $('#transactionId').val('');
          currentTransactionId = null;
        }

        return;
      }

      if (ddata[0] === 4) {
        logMsg('CallError received: ' + JSON.stringify(ddata));
        return;
      }

      // Handle incoming Calls from Central System
      if (ddata[0] === 2) {
        const uniqueId = ddata[1];
        const action = ddata[2];
        const payload = ddata[3] || {};

        switch (action) {
          case 'RemoteStartTransaction':
            // Accept and auto-start
            safeSend(JSON.stringify([3, uniqueId, { status: 'Accepted' }]));
            $('#TAG').val(payload.idTag || $('#TAG').val());
            setTimeout(startTransaction, 100);
            break;

          case 'RemoteStopTransaction':
            safeSend(JSON.stringify([3, uniqueId, { status: 'Accepted' }]));
            // Stop any running transaction
            stopTransaction();
            $('.indicator').hide(); $('#blue').show();
            break;

          case 'Reset':
            safeSend(JSON.stringify([3, uniqueId, { status: 'Accepted' }]));
            location.reload();
            break;

          case 'GetConfiguration':
            // Reply with supported keys
            const requested = payload.key || payload.keys || [];
            const supportedKeys = [
              { key: 'NumberOfConnectors', readonly: false, value: String(SIM_NUMBER_OF_CONNECTORS) },
              { key: 'MeterValuesSampleInterval', readonly: false, value: String(Math.floor(SIM_MV_SAMPLE_INTERVAL_MS / 1000)) },
            ];
            let configurationKey = [];
            let unknownKey = [];
            if (requested && requested.length > 0) {
              requested.forEach(function (rk) {
                const found = supportedKeys.find(k => (k.key || '').toLowerCase() === String(rk).toLowerCase());
                if (found) configurationKey.push(found);
                else unknownKey.push(rk);
              });
            } else {
              configurationKey = supportedKeys;
            }
            safeSend(JSON.stringify([3, uniqueId, { configurationKey, unknownKey }]));
            break;

          case 'ChangeConfiguration':
            let status = 'Rejected';
            if (typeof payload.key === 'string') {
              const lk = payload.key.toLowerCase();
              if (lk === 'numberofconnectors') {
                const n = parseInt(payload.value);
                if (!isNaN(n) && n > 0 && n < 33) {
                  SIM_NUMBER_OF_CONNECTORS = n;
                  $('#numberOfConnectors').val(String(n));
                  status = 'Accepted';
                }
              } else if (lk === 'metervaluessampleinterval') {
                const s = parseInt(payload.value);
                if (!isNaN(s) && s >= 0) {
                  SIM_MV_SAMPLE_INTERVAL_MS = s * 1000;
                  $('#meterValuesSampleInterval').val(String(s));
                  status = 'Accepted';
                  restart_mv_loop_if_running();
                }
              }
            }
            safeSend(JSON.stringify([3, uniqueId, { status }]));
            break;

          case 'TriggerMessage':
            if (payload.requestedMessage === 'MeterValues') {
              safeSend(JSON.stringify([3, uniqueId, { status: 'Accepted' }]));
              send_meterValue();
            } else {
              safeSend(JSON.stringify([4, uniqueId, 'NotImplemented', 'Requested TriggerMessage not supported', {}]));
            }
            break;

          default:
            safeSend(JSON.stringify([4, uniqueId, 'NotImplemented', 'Action not supported by simulator', {}]));
            break;
        }
      }
    };

    _websocket.onclose = function (evt) {
      logMsg('WebSocket closed: ' + (evt && evt.code));
      $('#connect').text('Connect').css('background', '#369');
      if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }
      _websocket = null;
      $('.indicator').hide(); $('#red').show();
    };

    _websocket.onerror = function (err) {
      logMsg('WebSocket error: ' + JSON.stringify(err));
      console.error(err);
    };
  }

  function wsDisconnect() {
    if (_websocket) {
      logMsg('Disconnecting WebSocket...');
      try { _websocket.close(3001); } catch (e) { console.warn('Close failed', e); }
      _websocket = null;
    }

    // Clear timers and UI state right away
    if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }
    if (mvLoopIntervalId) { clearInterval(mvLoopIntervalId); mvLoopIntervalId = null; }
    if (dataTransferLoopId) { clearInterval(dataTransferLoopId); dataTransferLoopId = null; }

    $('.indicator').hide(); $('#red').show();
    $('#connect').text('Connect').css('background', '#369');
  }

  function BootNotification() {
    if (!isWebSocketOpen()) { logMsg('WebSocket not connected for BootNotification'); return; }
    const BN = JSON.stringify([2, id, 'BootNotification', {
      chargePointVendor: 'AVT-Company',
      chargePointModel: 'AVT-Express',
      chargePointSerialNumber: 'avt.001.13.1',
      chargeBoxSerialNumber: 'avt.001.13.1.01',
      firmwareVersion: '0.9.87',
      meterType: 'AVT NQC-ACDC',
      meterSerialNumber: 'avt.001.13.1.01',
    }]);
    logMsg('Sending BootNotification...');
    safeSend(BN);
  }

  function startHB(intervalMs) {
    const ms = Number(intervalMs) || SIM_HEARTBEAT_INTERVAL_MS;
    SIM_HEARTBEAT_INTERVAL_MS = ms;
    if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }
    // send one immediately
    send_heartbeat();
    heartbeatIntervalId = setInterval(send_heartbeat, ms);
    logMsg('Heartbeat scheduled every ' + ms + ' ms');
  }

  function send_heartbeat() {
    if (!isWebSocketOpen()) return;
    sessionStorage.setItem('LastAction', 'Heartbeat');
    const HB = JSON.stringify([2, id, 'Heartbeat', {}]);
    logMsg('Sending Heartbeat');
    safeSend(HB);
  }

  function startTransaction() {
    if (!isWebSocketOpen()) { logMsg('WebSocket not connected!'); return; }
    sessionStorage.setItem('LastAction', 'startTransaction');
    $('.indicator').hide(); $('#green').show();
    connectorLocked = true;
    currentSoC = parseFloat($('#startingSoC').val()) || currentSoC;
    // generate a local provisional transaction id
    currentTransactionId = ++localTxCounter;
    $('#transactionId').val(currentTransactionId);

    const connectorId = parseInt($('#CUID').val()) || 1;
    const payload = [2, id, 'StartTransaction', {
      connectorId,
      idTag: $('#TAG').val(),
      timestamp: new Date().toISOString(),
      meterStart: parseInt($('#metervalue').val()) || 0,
    }];
    logMsg('Sending StartTransaction... (provisional tx ' + currentTransactionId + ')');
    safeSend(JSON.stringify(payload));

    // Send connector status notification (Charging) with additional vendor fields
    setTimeout(function () {
      const SN = JSON.stringify([2, id, 'StatusNotification', {
        connectorId: connectorId,
        status: 'Charging',
        errorCode: 'NoError',
        info: '',
        timestamp: new Date().toISOString()
      }]);
      safeSend(SN);
      logMsg('Sent connector status: Charging');
    }, 200);
  }

  function stopTransaction() {
    if (!isWebSocketOpen()) { logMsg('WebSocket not connected!'); return; }
    sessionStorage.setItem('LastAction', 'stopTransaction');
    $('.indicator').hide(); connectorLocked = false; $('#blue').show();

    const transactionId = (currentTransactionId && Number(currentTransactionId) > 0) ? Number(currentTransactionId) : (Number($('#transactionId').val()) || 0);
    const payload = [2, id, 'StopTransaction', {
      transactionId,
      idTag: $('#TAG').val(),
      timestamp: new Date().toISOString(),
      meterStop: parseInt($('#metervalue').val()) || 0,
      reason: 'Remote'
    }];
    logMsg('Sending StopTransaction for transaction ' + transactionId);
    safeSend(JSON.stringify(payload));

    setTimeout(function () {
      const SN = JSON.stringify([2, id, 'StatusNotification', {
        connectorId: parseInt($('#CUID').val()) || 1,
        status: 'Available',
        errorCode: 'NoError',
        info: '',
        timestamp: new Date().toISOString()
      }]);
      safeSend(SN);
      logMsg('Sent connector status: Available');
      $('#transactionId').val(''); currentTransactionId = null;
    }, 200);
  }

  function send_meterValue() {
    if (!isWebSocketOpen()) { logMsg('WebSocket not connected!'); return; }
    sessionStorage.setItem('LastAction', 'MeterValues');
    const val = parseFloat($('#metervalue').val()) || 0;
    const connectorId = parseInt($('#CUID').val()) || 1;
    const nowIso = new Date().toISOString();
    const sampled = [
      { value: String(val), measurand: 'Energy.Active.Import.Register', unit: 'Wh' },
      { value: String(Math.max(0, Math.round(val / (SIM_MV_SAMPLE_INTERVAL_MS / 1000)))), measurand: 'Power.Active.Import', unit: 'W' },
      { value: '10', measurand: 'Current.Import', unit: 'A' }
    ];

    if ($('#enableSoC').val() === 'true' && connectorLocked) {
      const socInc = parseFloat($('#socIncrement').val()) || 0.5;
      currentSoC = Math.min(100, currentSoC + socInc);
      sampled.push({ value: String(Math.round(currentSoC)), measurand: 'SoC', unit: 'Percent' });
      logMsg('SoC updated: ' + currentSoC.toFixed(1) + '%');
    }

    // Build MeterValues payload; include transactionId only if we have a valid id
    const mvPayload = {
      connectorId,
      meterValue: [{ timestamp: nowIso, sampledValue: sampled }]
    };
    if (currentTransactionId && Number(currentTransactionId) > 0) {
      mvPayload.transactionId = Number(currentTransactionId);
    }
    const MV = JSON.stringify([2, id, 'MeterValues', mvPayload]);


    logMsg('Sending MeterValues');
    safeSend(MV);
  }

  function send_initial_status_for_connectors() {
    if (!isWebSocketOpen()) return;
    const uiN = parseInt($('#numberOfConnectors').val()) || SIM_NUMBER_OF_CONNECTORS;
    SIM_NUMBER_OF_CONNECTORS = uiN;
    for (let cid = 1; cid <= SIM_NUMBER_OF_CONNECTORS; cid++) {
      const SN = JSON.stringify([2, id, 'StatusNotification', {
        connectorId: cid,
        status: 'Available',
        errorCode: 'NoError',
        info: '',
        timestamp: new Date().toISOString()
      }]);
      safeSend(SN);
    }
  }

  function restart_mv_loop_if_running() {
    if (mvLoopIntervalId) { clearInterval(mvLoopIntervalId); mvLoopIntervalId = null; start_mv_loop(); }
  }

  function start_mv_loop() {
    const counter = Number($('#meterSendTimes').val()) || 0;
    let times = 0;
    mvLoopIntervalId = setInterval(function () {
      times += 1;
      const Myelement = document.getElementById('metervalue');
      const val = Number(Myelement.value);
      const inc = Number($('#meterIncrement').val()) || 1;
      Myelement.value = (val + inc).toString();
      send_meterValue();
      if (counter > 0 && times >= counter) { clearInterval(mvLoopIntervalId); mvLoopIntervalId = null; }
    }, SIM_MV_SAMPLE_INTERVAL_MS);
  }

  function start_data_transfer_loop() {
    const counter = Number($('#meterSendTimes').val()) || 0;
    let times = 0;
    dataTransferLoopId = setInterval(function () {
      times += 1;
      send_data_transfer_soc();
      if (counter > 0 && times >= counter) { clearInterval(dataTransferLoopId); dataTransferLoopId = null; logMsg('DataTransfer loop completed'); }
    }, SIM_MV_SAMPLE_INTERVAL_MS);
    logMsg('Started DataTransfer loop');
  }

  function send_data_transfer_soc() {
    if (!isWebSocketOpen() || !connectorLocked) { logMsg('Must be connected and charging to send DataTransfer'); return; }
    if ($('#enableDataTransfer').val() !== 'true') { logMsg('DataTransfer disabled in settings'); return; }
    const vendorId = $('#vendorId').val() || 'Generic';
    const socInc = parseFloat($('#socIncrement').val()) || 0.5;
    currentSoC = Math.min(100, currentSoC + socInc);
    const data = { soc: Math.round(currentSoC), timestamp: new Date().toISOString() };
    const DT = JSON.stringify([2, id, 'DataTransfer', { vendorId, messageId: 'SoCData', data: JSON.stringify(data) }]);
    logMsg('Sending DataTransfer SoC: ' + currentSoC.toFixed(1) + '% via ' + vendorId);
    safeSend(DT);
  }

  // Bind UI
  $(document).ready(function () {
    $('.indicator').hide(); $('#red').show();
    // Version visibility so you can confirm the browser loaded the latest script
    logMsg('Simulator version: ' + SIMULATOR_VERSION + ' loaded');

    $('#connect').click(function () {
      $('.indicator').hide();
      $('#messages').html('');
      // Toggle connect/disconnect depending on current socket state
      if (isWebSocketOpen()) {
        wsDisconnect();
      } else {
        wsConnect();
      }
    });
    $('#send').click(function () { if (isWebSocketOpen()) { sessionStorage.setItem('LastAction','Authorize'); const Auth = JSON.stringify([2, id, 'Authorize', { idTag: $('#TAG').val() }]); logMsg('Sending Authorize'); safeSend(Auth); } else logMsg('WebSocket not connected!'); });
    $('#start').click(startTransaction);
    $('#stop').click(stopTransaction);
    $('#mv').click(send_meterValue);
    $('#mvp').click(function () { const i = Number($('#meterValuesSampleInterval').val()); if (!isNaN(i) && i >= 0) { SIM_MV_SAMPLE_INTERVAL_MS = i * 1000; } start_mv_loop(); });
    $('#heartbeat').click(send_heartbeat);
    $('#status').click(function () { if (!isWebSocketOpen()) { logMsg('WebSocket not connected!'); return; } sessionStorage.setItem('LastAction','StatusNotification'); const SN = JSON.stringify([2, id, 'StatusNotification', { connectorId: parseInt($('#CUID').val()) || 1, status: $('#ConnectorStatus').val(), errorCode: 'NoError', info: '', timestamp: new Date().toISOString() }]); safeSend(SN); });

    $('#send_data_transfer').click(send_data_transfer_soc);
    $('#data_transfer_loop').click(function () { if (dataTransferLoopId) { clearInterval(dataTransferLoopId); dataTransferLoopId = null; logMsg('Stopped DataTransfer loop'); $(this).text('Send DataTransfer Loop'); } else { start_data_transfer_loop(); $(this).text('Stop DataTransfer Loop'); } });

    $('#connect').on('change', function () { if (_websocket) { _websocket.close(3001); } });

    // Initialize UI-configurable simulator parameters
    const uiN = parseInt($('#numberOfConnectors').val()); if (!isNaN(uiN) && uiN > 0) SIM_NUMBER_OF_CONNECTORS = uiN;
    const uiI = parseInt($('#meterValuesSampleInterval').val()); if (!isNaN(uiI) && uiI >= 0) SIM_MV_SAMPLE_INTERVAL_MS = uiI * 1000;

    // Cleanup on unload
    window.addEventListener('beforeunload', function () { if (_websocket) { try { _websocket.close(3001); } catch (e) {} _websocket = null; } if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; } if (mvLoopIntervalId) { clearInterval(mvLoopIntervalId); mvLoopIntervalId = null; } if (dataTransferLoopId) { clearInterval(dataTransferLoopId); dataTransferLoopId = null; } });
  });

})();
  // Simulator configuration (can be changed via UI or ChangeConfiguration)
  let SIM_NUMBER_OF_CONNECTORS = 1;
  let SIM_MV_SAMPLE_INTERVAL_MS = 1000; // default 1s
  const SIM_MEASURANDS = [
    "Energy.Active.Import.Register",
    "Power.Active.Import",
    "Current.Import",
  ];
  let SIM_HEARTBEAT_INTERVAL_MS = 60000;
  let mvLoopIntervalId = null;
  let dataTransferLoopId = null;

  // SoC tracking variables
  let currentSoC = 25; // Starting SoC percentage


/**
 * Generate a random identifier string (36 chars). Uses the local character table.
 * @returns {string}
 */
function randomId() {
  let result = '';
  for (let i = 0; i < 36; i++) {
    const idx = Math.floor(Math.random() * POSSIBLE_CHARS.length);
    result += POSSIBLE_CHARS.charAt(idx);
  }
  id = result;
  return id;
}


function wsConnect() {
  // Ensure clean state for each connect attempt
  msgCounter = 0; // reset message counter so the next incoming message is treated as the BootNotification response
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }

  // FIX: Use direct URL instead of empty select value
  const CP = $("#CP").val();
  
  console.log("Attempting to connect to:", CP);

  if (_websocket) {
    $("#red").show();
    _websocket.close(3001);
  } else {
    _websocket = new WebSocket(CP, ["ocpp1.6", "ocpp1.5"]);
    _websocket.onopen = function (authorizationData) {
      logMsg("WebSocket connected successfully!");
      sessionStorage.setItem("LastAction", "BootNotification");
      $("#blue").show();
      BootNotification();

      $("#connect").text("Disconnect").css("background", "green");
    };

    _websocket.onmessage = function (msg) {
      msgCounter++;
      let ddata;
      try {
        ddata = JSON.parse(msg.data);
      } catch (err) {
        console.warn("Failed to parse incoming message as JSON", err, msg.data);
        return;
      }
      console.log("Received message:", ddata);
      
      if (msgCounter === 1) {
        const hb_interval = handleData(ddata);
        sessionStorage.setItem("Configuration", hb_interval);
        startHB(Number(hb_interval) * 1000);
        // After boot is accepted, send initial StatusNotifications per connector
        try {
          setTimeout(function () {
            send_initial_status_for_connectors();
          }, 200);
        } catch (e) {
          console.warn("Failed to send initial connector statuses", e);
        }
      }

      if (ddata[0] === 3) {
        la = getLastAction();

        if (la == "startTransaction") {
          logMsg("Data exchange successful!");
          var transactionId = ddata[2].transactionId;
          $("#transactionId").val(transactionId);
          logMsg("TransactionId: " + transactionId);
          console.log("TransactionId: " + JSON.stringify(transactionId));
          document.getElementById("ConnectorStatus").value = "Charging";
        }
        if (la === "stopTransaction") {
          document.getElementById("ConnectorStatus").value = "Available";
        }
        logMsg("Response: " + JSON.stringify(ddata[2]));
      } else if (ddata[0] === 4) {
        logMsg("Data exchange failed - JSON is not accepted!");
      } else if (ddata[0] === 2) {
        logMsg("Received OCPP call: " + ddata[2]);
        id = ddata[1];

        switch (ddata[2]) {
          case "Reset":
            //Reset type SOFT, HARD
            var ResetS = JSON.stringify([3, id, { status: "Accepted" }]);
            _websocket.send(ResetS);
            location.reload();
            break;
          case "RemoteStopTransaction":
            //TransactionID
            var remStp = JSON.stringify([3, id, { status: "Accepted" }]);
            safeSend(remStp);

            $("#transactionId").val(ddata[3].transactionId);

            stopTransaction();
            $(".indicator").hide();
            $("#blue").show();
            break;
          case "RemoteStartTransaction":
            // FIX: Immediately respond with Accepted and auto-start transaction
            logMsg("Received RemoteStartTransaction - responding with Accepted...");
            $("#TAG").val(ddata[3].idTag);
            var remStrt = JSON.stringify([3, id, { status: "Accepted" }]);
            _websocket.send(remStrt);
            logMsg("Sent RemoteStartTransaction Accepted response");
            
            // Auto-start transaction immediately after accepting
            setTimeout(function() {
              logMsg("Auto-starting transaction after RemoteStartTransaction...");
              startTransaction();
            }, 100);
            break;
          case "UnlockConnector":
            //connectorId
            var UC = JSON.stringify([3, id, { status: "Accepted" }]);
            _websocket.send(UC);
            break;
          case "GetConfiguration":
            // Respond with supported configuration keys
            var requested = [];
            try {
              var payload = ddata[3] || {};
              requested = payload.key || payload.keys || [];
            } catch (e) {}
            var supportedKeys = [
              { key: "NumberOfConnectors", readonly: false, value: String(SIM_NUMBER_OF_CONNECTORS) },
              { key: "MeterValuesSampleInterval", readonly: false, value: String(Math.floor(SIM_MV_SAMPLE_INTERVAL_MS / 1000)) },
            ];
            var configurationKey = [];
            var unknownKey = [];
            if (requested && requested.length > 0) {
              requested.forEach(function (rk) {
                var found = supportedKeys.find(function (k) { return (k.key || "").toLowerCase() === String(rk).toLowerCase(); });
                if (found) configurationKey.push(found);
                else unknownKey.push(rk);
              });
            } else {
              configurationKey = supportedKeys;
            }
            var cfg = JSON.stringify([3, id, { configurationKey: configurationKey, unknownKey: unknownKey }]);
            _websocket.send(cfg);
            break;
          case "ChangeConfiguration":
            // Update internal simulator config if key is supported
            var ccPayload = ddata[3] || {};
            var key = ccPayload.key;
            var value = ccPayload.value;
            var status = "Rejected";
            if (typeof key === "string") {
              var lk = key.toLowerCase();
              if (lk === "numberofconnectors") {
                var n = parseInt(value);
                if (!isNaN(n) && n > 0 && n < 33) {
                  SIM_NUMBER_OF_CONNECTORS = n;
                  $("#numberOfConnectors").val(String(n));
                  status = "Accepted";
                }
              } else if (lk === "metervaluessampleinterval") {
                var s = parseInt(value);
                if (!isNaN(s) && s >= 0) {
                  SIM_MV_SAMPLE_INTERVAL_MS = s * 1000;
                  $("#meterValuesSampleInterval").val(String(s));
                  status = "Accepted";
                  // Restart loop if running
                  restart_mv_loop_if_running();
                }
              }
            }
            var ccResp = JSON.stringify([3, id, { status: status }]);
            _websocket.send(ccResp);
            break;
          case "TriggerMessage":
            // Called by CPMS asking ChargePoint to execute the instruction
            // Implemented for MeterValues

            switch (ddata[3].requestedMessage) {
              case "MeterValues":
                var remStrt = JSON.stringify([3, id, { status: "Accepted" }]);
                _websocket.send(remStrt);
                send_meterValue();
                break;
              default:
                // Proper OCPP CallError: [4, uniqueId, errorCode, errorDescription, errorDetails]
                var error = JSON.stringify([4, id, "NotImplemented", "Requested TriggerMessage not supported", {}]);
                _websocket.send(error);
            }

            break;
          default:
            // Proper OCPP CallError for unsupported actions
            var errorDef = JSON.stringify([4, id, "NotImplemented", "Action not supported by simulator", {}]);
            _websocket.send(errorDef);
            break;
        }
      }
    };

    _websocket.onclose = function (evt) {
      logMsg("WebSocket closed with code: " + evt.code);
      $("#connect").text("Connect").css("background", "#369");
      // Clear heartbeat timer if present
      if (heartbeatIntervalId) {
        clearInterval(heartbeatIntervalId);
        heartbeatIntervalId = null;
      }
      if (evt.code == 3001) {
        logMsg("ws closed normally");
        _websocket = null;
      } else {
        logMsg("ws connection error: " + evt.code + " - attempting reconnect");
        $("#messages").html("");
        _websocket = null;
        // Don't auto-reconnect on error to avoid loops
      }
    }; 

    _websocket.onerror = function (evt) {
      logMsg("WebSocket error: " + evt.type);
      console.error("WebSocket error details:", evt);
      if (_websocket.readyState == 1) {
        $("#red").show();
      }
    };
  }
}

function logMsg(err) {
  console.log(err);
  $("#messages").append("<li>" + err + "</li>");
  $("#console").scrollTop($("#console").prop('scrollHeight'));
}

/**
 * Returns true if the WebSocket is open and usable.
 * @returns {boolean}
 */
function isWebSocketOpen() {
  return !!(_websocket && _websocket.readyState === WebSocket.OPEN);
}

/**
 * Safely send a message over the websocket.
 * @param {string} message JSON string to send
 */
function safeSend(message) {
  if (!isWebSocketOpen()) {
    logMsg("WebSocket not connected!");
    return;
  }
  _websocket.send(message);
}

function Authorize() {
  if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
    logMsg("WebSocket not connected!");
    return;
  }
  
  sessionStorage.setItem("LastAction", "Authorize");
  var Auth = JSON.stringify([
    2,
    id,
    "Authorize",
    { idTag: $("#TAG").val() },
  ]);
  logMsg("Sending Authorize request...");
  _websocket.send(Auth);
}

function startTransaction() {
  if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
    logMsg("WebSocket not connected!");
    return;
  }
  
  sessionStorage.setItem("LastAction", "startTransaction");
  $(".indicator").hide();
  $("#green").show();
  connectorLocked = true;
  logMsg("Connector status changed to: " + connectorLocked);
  
  // Reset SoC to starting value when transaction starts
  currentSoC = parseFloat($("#startingSoC").val()) || 25;
  logMsg("SoC reset to: " + currentSoC + "%");
  
  var connectorId = parseInt($("#CUID").val());
  console.log("connectorId", connectorId);
  var strtT = JSON.stringify([
    2,
    id,
    "StartTransaction",
    {
      connectorId: connectorId,
      idTag: $("#TAG").val(),
      timestamp: new Date().toISOString(),
      meterStart: parseInt($("#metervalue").val()),
      reservationId: 0,
    },
  ]);
  logMsg("Sending StartTransaction request...");
  _websocket.send(strtT);
  
  // Send connector status notification
  setTimeout(function() {
    var SN = JSON.stringify([
      2,
      id,
      "StatusNotification",
      {
        connectorId: connectorId,
        status: "Charging",
        errorCode: "NoError",
        info: "",
        timestamp: new Date().toISOString()
      },
    ]);
    _websocket.send(SN);
    logMsg("Sent connector status: Charging");
  }, 200);
}

function stopTransaction() {
  if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
    logMsg("WebSocket not connected!");
    return;
  }
  
  sessionStorage.setItem("LastAction", "stopTransaction");
  $(".indicator").hide();
  connectorLocked = false;
  logMsg("Connector status changed to: " + connectorLocked);
  $("#blue").show();
  const stpT = JSON.stringify([
    2,
    id,
    "StopTransaction",
    {
      transactionId: Number($("#transactionId").val()),
      idTag: $("#TAG").val(),
      timestamp: new Date().toISOString(),
      meterStop: parseInt($("#metervalue").val()),
      reason: "Remote"
    },
  ]);
  logMsg("Sending StopTransaction request...");
  safeSend(stpT);
  
  // Send connector status notification
  setTimeout(function() {
    var SN = JSON.stringify([
      2,
      id,
      "StatusNotification",
      {
        connectorId: parseInt($("#CUID").val()),
        status: "Available",
        errorCode: "NoError",
        info: "",
        timestamp: new Date().toISOString()
      },
    ]);
    _websocket.send(SN);
    logMsg("Sent connector status: Available");
  }, 200);
}

function handleData(data, request = false) {
  var lastAction = getLastAction();
  if (lastAction == "BootNotification") {
    data = data[2];
    heartbeat_interval = data.interval;
    return heartbeat_interval;
  } else if (lastAction == "StartTransaction") {
    return "StartTransaction";
  } else if (1 == 2) {
    alert("else");
  }
}

function getLastAction() {
  var LastAction = sessionStorage.getItem("LastAction");
  return LastAction;
}

function BootNotification() {
  if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
    logMsg("WebSocket not connected for BootNotification!");
    return;
  }
  
  var BN = JSON.stringify([
    2,
    id,
    "BootNotification",
    {
      chargePointVendor: "AVT-Company",
      chargePointModel: "AVT-Express",
      chargePointSerialNumber: "avt.001.13.1",
      chargeBoxSerialNumber: "avt.001.13.1.01",
      firmwareVersion: "0.9.87",
      iccid: "",
      imsi: "",
      meterType: "AVT NQC-ACDC",
      meterSerialNumber: "avt.001.13.1.01",
    },
  ]);

  logMsg("Sending BootNotification...");
  safeSend(BN);
}

function startHB(interval) {
  // Validate and normalize interval in milliseconds
  var ms = Number(interval) || SIM_HEARTBEAT_INTERVAL_MS;
  if (ms <= 0) ms = SIM_HEARTBEAT_INTERVAL_MS;

  logMsg("Setting heartbeat interval to " + ms + " ms");
  SIM_HEARTBEAT_INTERVAL_MS = ms;

  // Clear any previously scheduled heartbeat to avoid duplicates
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }

  // Send one heartbeat immediately and then schedule recurring heartbeats
  send_heartbeat();
  heartbeatIntervalId = setInterval(send_heartbeat, ms);
}

function send_heartbeat() {
  if (!isWebSocketOpen()) {
    return;
  }
  
  sessionStorage.setItem("LastAction", "Heartbeat");
  const HB = JSON.stringify([2, id, "Heartbeat", {}]);
  logMsg("Sending Heartbeat: " + HB);
  safeSend(HB);
}

function send_meterValue() {
  if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
    logMsg("WebSocket not connected!");
    return;
  }

  console.log("Sending MeterValues...");

  sessionStorage.setItem("LastAction", "MeterValues");
  var val = parseFloat($("#metervalue").val());
  var connectorId = parseInt($("#CUID").val()) || 1;
  var nowIso = new Date().toISOString();
  
  // Build sampled values array
  var sampled = [
    { value: String(val), measurand: "Energy.Active.Import.Register", unit: "Wh" },
    { value: String(Math.max(0, Math.round(val / (SIM_MV_SAMPLE_INTERVAL_MS/1000)) )), measurand: "Power.Active.Import", unit: "W" },
    { value: "10", measurand: "Current.Import", unit: "A" }
  ];
  
  // Add SoC data if enabled
  const enableSoC = $("#enableSoC").val() === "true";
  if (enableSoC && connectorLocked) {
    // Increment SoC
    const socIncrement = parseFloat($("#socIncrement").val()) || 0.5;
    currentSoC = Math.min(100, currentSoC + socIncrement);
    
    // Add SoC as ISO 15118 measurand
    sampled.push({
      value: String(Math.round(currentSoC)),
      measurand: "SoC",
      context: "Sample.Periodic",
      format: "Raw",
      unit: "Percent"
    });
    
    logMsg("SoC updated: " + currentSoC.toFixed(1) + "%");
  }
  
  var MV = JSON.stringify([
    2,
    id,
    "MeterValues",
    {
      connectorId: connectorId,
      transactionId: Number($("#transactionId").val()),
      meterValue: [
        {
          timestamp: nowIso,
          sampledValue: sampled,
        },
      ],
    },
  ]);

  console.log("Sending MV", MV);
  _websocket.send(MV);
}

function send_data_transfer_soc() {
  if (!isWebSocketOpen() || !connectorLocked) {
    logMsg("Must be connected and charging to send DataTransfer");
    return;
  }

  sessionStorage.setItem("LastAction", "DataTransfer");
  
  const vendorId = $("#vendorId").val() || "Generic";
  const enableDataTransfer = $("#enableDataTransfer").val() === "true";
  
  if (!enableDataTransfer) {
    logMsg("DataTransfer disabled in settings");
    return;
  }

  // Increment SoC
  const socIncrement = parseFloat($("#socIncrement").val()) || 0.5;
  currentSoC = Math.min(100, currentSoC + socIncrement);
  
  // Build vendor-specific data
  const data = build_vendor_soc_data(vendorId, currentSoC);
  
  const DT = JSON.stringify([
    2,
    id,
    "DataTransfer",
    {
      vendorId: vendorId,
      messageId: "SoCData",
      data: JSON.stringify(data)
    },
  ]);
  
  logMsg("Sending DataTransfer SoC: " + currentSoC.toFixed(1) + "% via " + vendorId);
  safeSend(DT);
}

function build_vendor_soc_data(vendorId, soc) {
  switch(vendorId) {
    case "ABB":
      return {
        soc: Math.round(soc),
        timestamp: new Date().toISOString(),
        chargingState: "Charging"
      };
      
    case "Alpitronic":
      return {
        batteryLevel: Math.round(soc),
        vehicleId: $("#TAG").val(),
        timestamp: new Date().toISOString()
      };
      
    case "Siemens":
      return {
        stateOfCharge: {
          value: Math.round(soc),
          unit: "%"
        },
        timestamp: new Date().toISOString()
      };
      
    case "EVBox":
      return {
        vehicle: {
          soc: Math.round(soc),
          idTag: $("#TAG").val()
        },
        timestamp: new Date().toISOString()
      };
      
    case "Generic":
    default:
      return {
        soc: Math.round(soc),
        timestamp: new Date().toISOString()
      };
  }
}

function restart_mv_loop_if_running() {
  if (mvLoopIntervalId) {
    clearInterval(mvLoopIntervalId);
    mvLoopIntervalId = null;
    start_mv_loop();
  }
}

function start_mv_loop() {
  var counter = Number($("#meterSendTimes").val());
  var times = 0;
  mvLoopIntervalId = setInterval(function () {
    times += 1;
    // Increment meter register
    var Myelement = document.getElementById("metervalue");
    var val = Number(Myelement.value);
    var incrementvalue = Number($("#meterIncrement").val());
    Myelement.value = (val + incrementvalue).toString();
    send_meterValue();
    if (counter > 0 && times >= counter) {
      clearInterval(mvLoopIntervalId);
      mvLoopIntervalId = null;
    }
  }, SIM_MV_SAMPLE_INTERVAL_MS);
}

function start_data_transfer_loop() {
  var counter = Number($("#meterSendTimes").val());
  var times = 0;
  
  dataTransferLoopId = setInterval(function () {
    times += 1;
    send_data_transfer_soc();
    
    if (counter > 0 && times >= counter) {
      clearInterval(dataTransferLoopId);
      dataTransferLoopId = null;
      logMsg("DataTransfer loop completed");
    }
  }, SIM_MV_SAMPLE_INTERVAL_MS);
  
  logMsg("Started DataTransfer loop");
}

function send_initial_status_for_connectors() {
  if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
    return;
  }
  
  // Ensure SIM_NUMBER_OF_CONNECTORS matches UI if present
  var uiN = parseInt($("#numberOfConnectors").val());
  if (!isNaN(uiN) && uiN > 0) SIM_NUMBER_OF_CONNECTORS = uiN;
  for (var cid = 1; cid <= SIM_NUMBER_OF_CONNECTORS; cid++) {
    var SN = JSON.stringify([
      2,
      id,
      "StatusNotification",
      {
        connectorId: cid,
        status: "Available",
        errorCode: "NoError",
        info: "",
        timestamp: new Date().toISOString()
      },
    ]);
    _websocket.send(SN);
  }
}

$(document).ready(function () {
  $(".indicator").hide();
  $("#red").show();

  //bind controls
  $("#connect").click(function () {
    $(".indicator").hide();
    $("#messages").html("");
    wsConnect();
  });

  $("#send").click(function () {
    Authorize();
  });

  $("#start").click(function () {
    startTransaction();
  });

  $("#stop").click(function () {
    stopTransaction();
  });
  
  $("#mv").click(function () {
    send_meterValue();
  });
  
  $("#mvp").click(function () {
    // Use simulator-level sample interval
    var i = Number($("#meterValuesSampleInterval").val());
    if (!isNaN(i) && i >= 0) {
      SIM_MV_SAMPLE_INTERVAL_MS = i * 1000;
    }
    start_mv_loop();
  });

  $("#heartbeat").click(function () {
    send_heartbeat();
  });

  $("#status").click(function () {
    if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
      logMsg("WebSocket not connected!");
      return;
    }
    
    sessionStorage.setItem("LastAction", "StatusNotification");
    console.log("sss", $("#ConnectorStatus").val());
    var SN = JSON.stringify([
      2,
      id,
      "StatusNotification",
      {
        connectorId: parseInt($("#CUID").val()),
        status: $("#ConnectorStatus").val(),
        errorCode: "NoError",
        info: "",
        timestamp: new Date().toISOString()
      },
    ]);
    _websocket.send(SN);
  });

  $("#data_transfer").click(function () {
    if (!_websocket || _websocket.readyState !== WebSocket.OPEN) {
      logMsg("WebSocket not connected!");
      return;
    }
    
    sessionStorage.setItem("LastAction", "DataTransfer");
    var DT = JSON.stringify([
      2,
      id,
      "DataTransfer",
      {
        vendorId: "rus.avt.cp",
        messageId: "GetChargeInstruction",
        data: "",
      },
    ]);
    _websocket.send(DT);
  });

  // DataTransfer controls
  $("#send_data_transfer").click(function () {
    send_data_transfer_soc();
  });

  $("#data_transfer_loop").click(function () {
    if (dataTransferLoopId) {
      clearInterval(dataTransferLoopId);
      dataTransferLoopId = null;
      logMsg("Stopped DataTransfer loop");
      $(this).text("Send DataTransfer Loop");
    } else {
      start_data_transfer_loop();
      $(this).text("Stop DataTransfer Loop");
    }
  });

  $("#connect").on("change", function () {
    if (_websocket) {
      _websocket.close(3001);
    }
  });

  // Initialize UI-configurable simulator parameters
  var uiN = parseInt($("#numberOfConnectors").val());
  if (!isNaN(uiN) && uiN > 0) SIM_NUMBER_OF_CONNECTORS = uiN;
  var uiI = parseInt($("#meterValuesSampleInterval").val());
  if (!isNaN(uiI) && uiI >= 0) SIM_MV_SAMPLE_INTERVAL_MS = uiI * 1000;

  // Cleanup resources on unload
  window.addEventListener('beforeunload', function () {
    if (_websocket) {
      try { _websocket.close(3001); } catch (e) {}
      _websocket = null;
    }
    if (heartbeatIntervalId) { clearInterval(heartbeatIntervalId); heartbeatIntervalId = null; }
    if (mvLoopIntervalId) { clearInterval(mvLoopIntervalId); mvLoopIntervalId = null; }
    if (dataTransferLoopId) { clearInterval(dataTransferLoopId); dataTransferLoopId = null; }
  });



})();
