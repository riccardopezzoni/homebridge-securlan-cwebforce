import type { PlatformConfig } from 'homebridge';
export type SensorKind = 'auto' | 'contact' | 'motion' | 'occupancy';
export type OutputMode = 'button' | 'switch' | 'garageDoor' | 'windowCovering' | 'lock';
export type AlarmExposeMode = 'system' | 'sectors';
export interface AlarmModeConfig {
    away?: string[];
    home?: string[];
    night?: string[];
}
export interface SecurlanOutputConfig {
    name?: string;
    displayName?: string;
    id?: string;
    idIndex?: number;
    pulseSeconds?: number;
    exposeAs?: OutputMode;
    enabled?: boolean;
    linkedSensorName?: string;
    linkedSensorId?: string;
    sensorOpenState?: string;
    sensorClosedState?: string;
}
export interface SensorOverrideConfig {
    name: string;
    kind?: SensorKind;
    displayName?: string;
}
export interface AlarmSectorOverrideConfig {
    id?: string;
    name?: string;
    displayName?: string;
    enabled?: boolean;
}
export interface SecurlanPlatformConfig extends PlatformConfig {
    baseUrl?: string;
    alarmBaseUrl?: string;
    username?: string;
    password?: string;
    pollIntervalSeconds?: number;
    requestTimeoutMs?: number;
    sector?: string;
    discoverOutputs?: boolean;
    removeMissingOutputs?: boolean;
    defaultOutputMode?: OutputMode;
    outputs?: SecurlanOutputConfig[];
    alarm?: {
        enabled?: boolean;
        exposeAs?: AlarmExposeMode;
        name?: string;
        allowControl?: boolean;
        modes?: AlarmModeConfig;
        removeMissing?: boolean;
        sectors?: AlarmSectorOverrideConfig[];
    };
    sensors?: {
        overrides?: SensorOverrideConfig[];
        removeMissing?: boolean;
    };
    matter?: {
        exposeOutputs?: boolean;
    };
}
export interface SecurlanSensorState {
    name: string;
    rawState: string;
}
export interface SecurlanOutputState {
    id: string;
    idIndex: number;
    name: string;
}
export interface SecurlanAlarmSectorState {
    id: string;
    name: string;
    armed: boolean;
    formName?: string;
}
export interface AccessoryContext {
    kind: 'sensor' | 'output' | 'alarm';
    id: string;
    displayName: string;
    alarmSector?: SecurlanAlarmSectorState;
    alarmSectors?: SecurlanAlarmSectorState[];
    sensorKind?: Exclude<SensorKind, 'auto'>;
    output?: SecurlanOutputConfig;
    outputMode?: OutputMode;
    linkedSensorId?: string;
    linkedSensorName?: string;
    lastTargetPosition?: number;
}
