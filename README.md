# OCPP 1.6 Charge Point Simulator

A simple, browser-based charge point (chargebox) simulator implementing OCPP 1.6 messages for testing and development of charging station backends.

Based on the old simpler version of the [OCPP-J-CP-Simulator](https://github.com/nenecmrf/OCPP-J-CP-Simulator)

Forked from [pvictormunoz/OCPP-1.6-Chargebox-Simulator](https://github.com/victormunoz/OCPP-1.6-Chargebox-Simulator)

---

## Features

- Connect to a Central System (CPMS) using WebSocket
- Handle BootNotification and configure Heartbeat intervals
- Authorize and Start/Stop transactions
- Send MeterValues (optional SoC included)
- Send StatusNotification and DataTransfer messages
- UI controls for runtime configuration (connectors, sample intervals, SoC, vendor data transfer)

---

## Quick start

1. Serve the project directory and open the simulator page in your browser:

   ```bash
   # Using Python 3
   python3 -m http.server 8000

   # or using Node (if available)
   npx http-server -p 8000
   ```

   Then open: `http://localhost:8000/simulator_ocpp_1.6.html`

2. Configure the **Central Station** (`CP`) WebSocket URL and click **Connect**.
3. The simulator sends a `BootNotification`; if accepted, the Central System responds with an `interval` (seconds) that the simulator uses for recurring Heartbeats.
4. Use the UI buttons to Authorize, Start/Stop transactions, send MeterValues, DataTransfer, StatusNotification, or trigger a manual Heartbeat.

---

## Heartbeat behavior

- On BootNotification acceptance the simulator will send one immediate Heartbeat and then schedule recurring Heartbeats at the interval returned by the Central System (default 60 seconds).
- The simulator keeps exactly one heartbeat timer and clears it on disconnect or reconnect to avoid duplicate heartbeats.
- You can manually force a Heartbeat with the **Heartbeat** button in the UI.

Defaults:
- `SIM_HEARTBEAT_INTERVAL_MS` is `60000` (60 seconds) until the Central System provides a different interval.

---

## UI Controls & Configuration

- **CP**: Central System WebSocket URL
- **Tag**: idTag used for Authorize / StartTransaction
- **Connector uid**: connector ID
- **Number of Connectors**: how many connectors to simulate
- **MeterValues Sample Interval**: interval in seconds for MeterValues loops
- **Enable SoC**: include SoC in MeterValues (Yes/No)
- **Starting SoC** and **SoC Increment**: control SoC progression during a charging session

---

## Troubleshooting & Tips

- If duplicate heartbeats appear, confirm you reconnected cleanly — the simulator clears previous heartbeat timers on reconnect/close.
- If BootNotification doesn't appear to be processed on reconnect, reconnect again (the simulator resets message counter on connect).
- For backend testing consider creating a minimal CPMS mock that accepts BootNotification and responds with an `interval` so you can validate Heartbeat timing.

---

## Contributing

Contributions welcome. Please open issues or PRs for improvements or bug fixes.

---

## License

No license is specified. Add a `LICENSE` file (e.g., MIT) if you want to make licensing explicit.
