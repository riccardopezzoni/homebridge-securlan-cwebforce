# homebridge-securlan-cwebforce

Homebridge dynamic platform for Securlan alarm panels exposed through the CWebForce web portal.

The plugin logs in to CWebForce, discovers alarm zones and outputs, and exposes them to HomeKit through Homebridge. It works with a minimal configuration first, then lets you add overrides for richer HomeKit services such as garage doors, locks, window coverings, and a single configurable alarm system.

## Features

- Automatically discovers CWebForce/Securlan zones.
- Exposes contact zones as HomeKit contact sensors.
- Exposes PIR/IR/VX-style zones as HomeKit motion sensors by default.
- Automatically discovers CWebForce outputs.
- Exposes outputs as momentary HomeKit buttons by default.
- Supports output overrides for:
  - garage doors
  - pedestrian gates or electric strikes as locks
  - binary window coverings
- Optionally exposes one HomeKit security system mapped to CWebForce sectors.
- Supports HomeKit alarm modes: Away, Home, Night, and Off.
- Preserves current sector state when changing only part of the alarm.
- Includes diagnostic CLI commands for discovery and alarm state checks.

## Requirements

- Homebridge 1.8 or newer.
- Node.js 20 or newer.
- A Securlan/CWebForce account that can access the web portal.

Default portal URLs:

```text
https://www.cwebforce.it/ev
```

## Installation

From the Homebridge UI, install:

```text
homebridge-securlan-cwebforce
```

Or install with npm:

```bash
npm install -g homebridge-securlan-cwebforce
```

If the package is not published to npm yet, install from GitHub:

```bash
npm install -g github:riccardopezzoni/homebridge-securlan-cwebforce
```

On the official Homebridge image or service install, Homebridge may use strict plugin resolution. If Homebridge starts with `-P /var/lib/homebridge/node_modules --strict-plugin-resolution`, install the plugin locally in the Homebridge directory:

```bash
cd /var/lib/homebridge
npm install homebridge-securlan-cwebforce
hb-service restart
```

For a specific GitHub build:

```bash
cd /var/lib/homebridge
npm install https://github.com/riccardopezzoni/homebridge-securlan-cwebforce/archive/main.tar.gz
hb-service restart
```

## Minimal Config

```json
{
  "platform": "SecurlanCWebForce",
  "name": "Securlan",
  "username": "YOUR_USERNAME",
  "password": "YOUR_PASSWORD"
}
```

With only this config, the plugin discovers zones and outputs automatically. Outputs are exposed as momentary switches because CWebForce outputs usually behave like pulses rather than stateful switches.

## Recommended Config

```json
{
  "platform": "SecurlanCWebForce",
  "name": "Securlan",
  "baseUrl": "https://www.cwebforce.it/ev",
  "alarmBaseUrl": "https://www.cwebforce.it/ev",
  "username": "YOUR_USERNAME",
  "password": "YOUR_PASSWORD",
  "pollIntervalSeconds": 60,
  "requestTimeoutMs": 45000,
  "sector": "TUTTI",
  "discoverOutputs": true,
  "defaultOutputMode": "button"
}
```

`pollIntervalSeconds` has a minimum of 15 seconds.

## Complete Example

```json
{
  "platform": "SecurlanCWebForce",
  "name": "Securlan",
  "username": "YOUR_USERNAME",
  "password": "YOUR_PASSWORD",
  "pollIntervalSeconds": 30,
  "outputs": [
    {
      "name": "APRI PEDONALE",
      "displayName": "Pedonale",
      "exposeAs": "lock",
      "pulseSeconds": 3
    },
    {
      "name": "Garage",
      "displayName": "Garage",
      "exposeAs": "garageDoor",
      "linkedSensorName": "PORTA GARAGE"
    }
  ],
  "alarm": {
    "enabled": true,
    "name": "Allarme Casa",
    "allowControl": true,
    "modes": {
      "away": ["001", "002", "003", "004", "005"],
      "home": ["001", "004", "005"],
      "night": ["001", "003", "004", "005"]
    }
  }
}
```

## Output Overrides

The `outputs` array is not the full list of outputs. It is only a list of overrides. Any discovered output without an override keeps the default behavior.

Overrides can match a discovered output by:

- `name`: discovered output name.
- `idIndex`: stable position on the CWebForce outputs page.
- `id`: exact CWebForce output id, if it is stable for your installation.

Supported `exposeAs` values:

- `button`: momentary HomeKit switch that turns itself off after the pulse.
- `switch`: same HomeKit service as `button`, useful if you prefer switch wording in config.
- `garageDoor`: HomeKit garage door opener, best used with `linkedSensorName`.
- `lock`: HomeKit lock mechanism, useful for pedestrian gates, doors, or electric strikes.
- `windowCovering`: binary open/closed HomeKit window covering, best used with `linkedSensorName`.

## Lock Outputs

Use `exposeAs: "lock"` for an output that unlocks a pedestrian gate or electric strike:

```json
{
  "outputs": [
    {
      "name": "APRI PEDONALE",
      "displayName": "Pedonale",
      "exposeAs": "lock",
      "pulseSeconds": 3
    }
  ]
}
```

Without a linked sensor, HomeKit shows the lock as unsecured when you unlock it, then secured again after `pulseSeconds`.

With a linked contact sensor, the lock state follows the sensor:

```json
{
  "name": "APRI PEDONALE",
  "displayName": "Pedonale",
  "exposeAs": "lock",
  "linkedSensorName": "PEDONALE"
}
```

## Garage Doors

Use `exposeAs: "garageDoor"` for a gate or garage output. Link it to a contact sensor when possible:

```json
{
  "outputs": [
    {
      "name": "Garage",
      "displayName": "Garage",
      "exposeAs": "garageDoor",
      "linkedSensorName": "PORTA GARAGE"
    }
  ]
}
```

## Linked Sensors

Some HomeKit services need state feedback. For example, a garage door should know whether it is open or closed. Link an output to a discovered zone with `linkedSensorName` or `linkedSensorId`.

Default contact-state mapping:

- `PRONTO` means closed/ready.
- `APERTO` means open.

Default motion-state mapping:

- `APERTO` means active.
- `PRONTO` means inactive.

If your installation uses inverted or different state labels, set them on the output override:

```json
{
  "name": "Garage",
  "displayName": "Garage",
  "exposeAs": "garageDoor",
  "linkedSensorName": "PORTA GARAGE",
  "sensorOpenState": "APERTO",
  "sensorClosedState": "PRONTO"
}
```

## Sensor Overrides

The plugin guesses sensor type from the zone name. You can override any zone:

```json
{
  "sensors": {
    "overrides": [
      {
        "name": "PORTA INGRESSO",
        "displayName": "Porta Ingresso",
        "kind": "contact"
      },
      {
        "name": "SENSORE SALA",
        "displayName": "Movimento Sala",
        "kind": "motion"
      }
    ]
  }
}
```

Supported sensor kinds:

- `auto`
- `contact`
- `motion`
- `occupancy`

## Alarm

Alarm exposure is disabled by default. To expose one HomeKit security system:

```json
{
  "alarm": {
    "enabled": true,
    "name": "Allarme Casa"
  }
}
```

By default the alarm is read-only. To allow HomeKit to insert or disinsert sectors:

```json
{
  "alarm": {
    "enabled": true,
    "allowControl": true
  }
}
```

For a single HomeKit alarm, configure which CWebForce sectors map to each HomeKit mode:

```json
{
  "alarm": {
    "enabled": true,
    "name": "Allarme Casa",
    "allowControl": true,
    "modes": {
      "away": ["001", "002", "003", "004", "005"],
      "home": ["001", "004", "005"],
      "night": ["001", "003", "004", "005"]
    }
  }
}
```

HomeKit behavior:

- Away arms the sectors in `away`.
- Home arms the sectors in `home`.
- Night arms the sectors in `night`.
- Off disarms the configured sectors.

If `modes` is omitted, Away, Home, and Night all use every discovered enabled sector. Sectors outside the configured mode lists are preserved when the plugin sends a command.

If you prefer to expose each sector as its own HomeKit security system:

```json
{
  "alarm": {
    "enabled": true,
    "exposeAs": "sectors"
  }
}
```

## Local Diagnostics

For local testing, create a private `.env` file:

```bash
cp .env.example .env
```

Edit `.env`, then run:

```bash
npm run securlan:list
```

The command logs in, prints discovered sensors, and prints discovered output names/ids with their `idIndex` values. It does not trigger any output.

To check alarm sector state without changing it:

```bash
npm run securlan:alarm
```

Development variants run directly from TypeScript sources:

```bash
npm run securlan:list:dev
npm run securlan:alarm:dev
```

## Matter

Homebridge v2 Matter support is opt-in. Enable Matter in Homebridge, then enable this plugin's Matter output exposure:

```json
{
  "matter": {
    "exposeOutputs": true
  }
}
```

Matter support currently targets momentary on/off outputs. HAP/HomeKit remains the primary path for sensors, locks, garage doors, window coverings, and alarm services.

## Development

```bash
npm install
npm run build
npm pack --dry-run
```

For development, use `npm run securlan:list:dev` and `npm run securlan:alarm:dev` after changing TypeScript sources.

## Safety Notes

This plugin can trigger real alarm-sector changes and real outputs such as gates, doors, locks, lights, or sirens. Test with read-only alarm mode first, then enable `alarm.allowControl` only when the sector mapping is correct.

Keep your CWebForce credentials private. Do not commit `.env` or Homebridge config files containing passwords.
