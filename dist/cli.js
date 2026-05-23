"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const securlanClient_1 = require("./securlanClient");
const settings_1 = require("./settings");
async function main() {
    loadDotEnv((0, node_path_1.resolve)(process.cwd(), '.env'));
    const command = process.argv[2] ?? 'list';
    if (!['list', 'alarm'].includes(command)) {
        throw new Error(`Comando sconosciuto "${command}". Usa: npm run securlan:list oppure npm run securlan:alarm`);
    }
    const username = readRequiredEnv('SECURLAN_USERNAME', 'CWEBFORCE_USERNAME');
    const password = readRequiredEnv('SECURLAN_PASSWORD', 'CWEBFORCE_PASSWORD');
    const baseUrl = process.env.SECURLAN_BASE_URL ?? settings_1.DEFAULT_BASE_URL;
    const alarmBaseUrl = process.env.SECURLAN_ALARM_BASE_URL ?? settings_1.DEFAULT_ALARM_BASE_URL;
    const sector = process.env.SECURLAN_SECTOR ?? 'TUTTI';
    const requestTimeoutMs = Number(process.env.SECURLAN_REQUEST_TIMEOUT_MS ?? settings_1.DEFAULT_REQUEST_TIMEOUT_MS);
    const client = new securlanClient_1.SecurlanClient({
        baseUrl,
        alarmBaseUrl,
        username,
        password,
        requestTimeoutMs,
    });
    if (command === 'alarm') {
        const alarmSectors = await client.getAlarmSectors();
        console.log(`CWebForce alarm: ${alarmBaseUrl}`);
        console.log('');
        console.log(`Settori allarme (${alarmSectors.length}):`);
        for (const sectorState of alarmSectors) {
            console.log(`- ${sectorState.name} (${sectorState.id}): ${sectorState.armed ? 'INSERITA' : 'NON INSERITA'}`);
        }
        return;
    }
    const sensors = await client.getSensors(sector);
    const outputs = await client.getOutputs();
    console.log(`CWebForce: ${baseUrl}`);
    console.log(`Settore: ${sector}`);
    console.log('');
    console.log(`Sensori trovati (${sensors.length}):`);
    for (const sensor of sensors) {
        console.log(`- ${sensor.name}: ${sensor.rawState}`);
    }
    console.log('');
    console.log(`Uscite trovate (${outputs.length}):`);
    outputs.forEach(output => {
        console.log(`- idIndex ${output.idIndex}: ${output.id} (${output.name})`);
    });
}
function loadDotEnv(path) {
    if (!(0, node_fs_1.existsSync)(path)) {
        return;
    }
    const content = (0, node_fs_1.readFileSync)(path, 'utf8');
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const separator = trimmed.indexOf('=');
        if (separator === -1) {
            continue;
        }
        const key = trimmed.slice(0, separator).trim();
        const value = unquote(trimmed.slice(separator + 1).trim());
        if (!process.env[key]) {
            process.env[key] = value;
        }
    }
}
function readRequiredEnv(...names) {
    for (const name of names) {
        const value = process.env[name];
        if (value) {
            return value;
        }
    }
    throw new Error(`Variabile ambiente mancante: ${names.join(' oppure ')}`);
}
function unquote(value) {
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
