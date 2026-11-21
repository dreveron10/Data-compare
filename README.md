# Data Compare

Flight data analyzer for high power rocketry. Load a flight's logs and get a 3D replay of the trajectory with the rocket's real tilt and roll, synced charts, and a summary checked against the altimeter's own numbers.

**Live site:** https://dreveron10.github.io/data-compare/

Everything runs in the browser. Files are never uploaded.

## Supported devices

| Device | Files | Status |
|---|---|---|
| Featherweight Blue Raven | `*_HR_*.csv`, `*_LR_*.csv`, `*_summary_*.csv`, `BR_deploy_settings_*.xlsx` (optional) | Phase 1 |
| Featherweight GPS tracker | flight CSV | Planned (Phase 2) |
| Fluctus, RRC3+, OpenRocket CSV | | Planned |

Files are recognized by their headers, not their names, so renamed files still work.

## Features

- **3D replay:** ascent path from the Blue Raven inertial navigation (colored by speed), rocket attitude from the 500 Hz quaternions (tilt and roll), boost flame, parachutes, event markers, and an attitude inset with a roll dial. Camera modes: follow, overview, ground.
- **Charts:** altitude, velocity, acceleration, tilt, roll rate, battery and pyro channel voltages. Synced cursor and zoom; click to jump the replay to that time.
- **Summary:** apogee, max velocity, burnout, tilt, roll, descent rates, deploy altitude and fire times. Each value is shown next to what the Blue Raven reported.
- **Deployment settings:** the condition matrix from the settings XLSX for each channel, with each condition marked met/unmet at the moment the channel fired.

## How the numbers are computed

- **Baro altitude:** `ASL - pad ASL` (pad ASL from the summary), then a 1 s running median (removes ejection pressure spikes) and a 0.2 s average. Apogee is searched within 2 s of the inertial apogee.
- **Fire times:** taken from the Blue Raven summary first; otherwise from the moment a channel with continuity drops below 1 V; otherwise from the LR `*_fired` flag (which lags the real fire by about 1.4 s).
- **Descent rates:** linear fits (drogue: apogee + 3 s to main fire; main: main fire + 4 s to landing).
- **3D heading:** the Blue Raven quaternions are relative to the pad attitude and have no compass heading. The heading is recovered by matching the rocket axis direction to the inertial velocity direction during ascent. Directions are shown as downrange/crossrange, not north/east.
- **Descent position:** the inertial horizontal position drifts after apogee, so the descent is drawn straight down from apogee (altitude only) until GPS support is added.

## Development

```bash
npm install
npm run dev        # local dev server
npm run build      # production build to dist/
npm run typecheck
```

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

Sample flights are in `public/samples/` and can be opened directly with `?sample=SN0614` or `?sample=SN1742`.
