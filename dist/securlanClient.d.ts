import type { SecurlanAlarmSectorState, SecurlanOutputConfig, SecurlanOutputState, SecurlanSensorState } from './types';
interface ClientOptions {
    baseUrl?: string;
    alarmBaseUrl?: string;
    username: string;
    password: string;
    requestTimeoutMs?: number;
}
export declare class SecurlanClient {
    private readonly baseUrl;
    private readonly alarmBaseUrl;
    private readonly username;
    private readonly password;
    private readonly requestTimeoutMs;
    private readonly cookies;
    private outputCache?;
    private outputCacheTime;
    private loggedIn;
    constructor(options: ClientOptions);
    getSensors(sector?: string): Promise<SecurlanSensorState[]>;
    triggerOutput(output: SecurlanOutputConfig): Promise<void>;
    getOutputIds(): Promise<string[]>;
    getOutputs(forceRefresh?: boolean): Promise<SecurlanOutputState[]>;
    getAlarmSectors(): Promise<SecurlanAlarmSectorState[]>;
    setAlarmSectors(desiredStates: Record<string, boolean>): Promise<SecurlanAlarmSectorState[]>;
    private resolveOutputId;
    private ensureLoggedIn;
    private requestText;
    private fetch;
    private storeCookies;
}
export declare function parseSensors(html: string): SecurlanSensorState[];
export declare function parseOutputs(html: string): SecurlanOutputState[];
export declare function parseAlarmSectors(html: string): SecurlanAlarmSectorState[];
export {};
