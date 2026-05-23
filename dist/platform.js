"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecurlanPlatform = void 0;
const securlanClient_1 = require("./securlanClient");
const settings_1 = require("./settings");
class SecurlanPlatform {
    log;
    config;
    api;
    Service;
    Characteristic;
    cachedAccessories = new Map();
    cachedMatterAccessories = new Map();
    sensorStatesById = new Map();
    sensorStatesByName = new Map();
    lockResetTimers = new Map();
    client;
    pollIntervalSeconds;
    matterOutputsPrepared = false;
    pollTimer;
    constructor(log, config, api) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.pollIntervalSeconds = Math.max(15, config.pollIntervalSeconds ?? settings_1.DEFAULT_POLL_INTERVAL_SECONDS);
        if (config.username && config.password) {
            this.client = new securlanClient_1.SecurlanClient({
                baseUrl: config.baseUrl ?? settings_1.DEFAULT_BASE_URL,
                alarmBaseUrl: config.alarmBaseUrl ?? settings_1.DEFAULT_ALARM_BASE_URL,
                username: config.username,
                password: config.password,
                requestTimeoutMs: config.requestTimeoutMs ?? settings_1.DEFAULT_REQUEST_TIMEOUT_MS,
            });
        }
        else {
            this.log.warn('Securlan non configurato: inserisci username e password nella config Homebridge.');
        }
        this.api.on('didFinishLaunching', () => {
            void this.didFinishLaunching();
        });
        this.api.on('shutdown', () => {
            if (this.pollTimer) {
                clearInterval(this.pollTimer);
            }
            for (const timer of this.lockResetTimers.values()) {
                clearTimeout(timer);
            }
        });
    }
    configureAccessory(accessory) {
        const typedAccessory = accessory;
        this.cachedAccessories.set(typedAccessory.UUID, typedAccessory);
        this.configureHapAccessory(typedAccessory);
    }
    configureMatterAccessory(accessory) {
        if (typeof accessory === 'object' && accessory && 'UUID' in accessory) {
            const matterAccessory = accessory;
            this.cachedMatterAccessories.set(matterAccessory.UUID, matterAccessory);
            this.log.debug(`Matter cached accessory restored: ${matterAccessory.UUID}`);
        }
    }
    async didFinishLaunching() {
        if (!this.client) {
            return;
        }
        await this.refreshOutputs();
        await this.pollOnce();
        this.pollTimer = setInterval(() => {
            void this.pollOnce();
        }, this.pollIntervalSeconds * 1000);
        this.log.info(`Securlan polling attivo ogni ${this.pollIntervalSeconds}s.`);
    }
    async pollOnce() {
        if (!this.client) {
            return;
        }
        try {
            const sensors = await this.client.getSensors(this.config.sector ?? 'TUTTI');
            const seenIds = new Set();
            for (const sensor of sensors) {
                const accessory = this.getOrCreateSensorAccessory(sensor);
                seenIds.add(accessory.context.id);
                this.sensorStatesById.set(accessory.context.id, sensor);
                this.sensorStatesByName.set(sensor.name, sensor);
                this.updateSensorAccessory(accessory, sensor);
            }
            this.updateLinkedOutputAccessories();
            if (this.config.alarm?.enabled) {
                await this.refreshAlarmSectors();
            }
            if (this.config.sensors?.removeMissing) {
                this.removeMissingSensorAccessories(seenIds);
            }
        }
        catch (error) {
            this.log.error(`Errore aggiornando Securlan: ${errorMessage(error)}`);
        }
    }
    async refreshAlarmSectors() {
        if (!this.client) {
            return;
        }
        const alarmSectors = this.mergeAlarmSectors(await this.client.getAlarmSectors());
        const exposeAs = this.config.alarm?.exposeAs ?? 'system';
        if (exposeAs === 'sectors') {
            this.refreshAlarmSectorAccessories(alarmSectors);
            return;
        }
        this.refreshAlarmSystemAccessory(alarmSectors);
    }
    refreshAlarmSystemAccessory(alarmSectors) {
        const enabledSectors = alarmSectors.filter(sector => sector.enabled !== false);
        const seenIds = new Set();
        const alarmName = this.config.alarm?.name ?? 'Securlan Alarm';
        const id = 'alarm:system';
        seenIds.add(id);
        const uuid = this.api.hap.uuid.generate(`${settings_1.PLUGIN_NAME}:${id}`);
        let accessory = this.cachedAccessories.get(uuid);
        if (!accessory) {
            accessory = new this.api.platformAccessory(alarmName, uuid);
            accessory.context = {
                kind: 'alarm',
                id,
                displayName: alarmName,
                alarmSectors: enabledSectors,
            };
            this.configureHapAccessory(accessory);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.cachedAccessories.set(uuid, accessory);
            this.log.info(`Nuovo allarme Securlan: ${alarmName}.`);
        }
        else {
            accessory.context.displayName = alarmName;
            accessory.context.alarmSectors = enabledSectors;
            accessory.context.alarmSector = undefined;
            this.configureHapAccessory(accessory);
        }
        this.updateAlarmSystemAccessory(accessory, enabledSectors);
        this.removeMissingAlarmAccessories(seenIds);
    }
    refreshAlarmSectorAccessories(alarmSectors) {
        const seenIds = new Set();
        for (const sector of alarmSectors) {
            if (sector.enabled === false) {
                continue;
            }
            const sectorName = sector.displayName ?? sector.name;
            const id = `alarm:${normalizeId(sector.id)}`;
            seenIds.add(id);
            const uuid = this.api.hap.uuid.generate(`${settings_1.PLUGIN_NAME}:${id}`);
            let accessory = this.cachedAccessories.get(uuid);
            if (!accessory) {
                accessory = new this.api.platformAccessory(sectorName, uuid);
                accessory.context = {
                    kind: 'alarm',
                    id,
                    displayName: sectorName,
                    alarmSector: sector,
                };
                this.configureHapAccessory(accessory);
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.cachedAccessories.set(uuid, accessory);
                this.log.info(`Nuovo settore allarme Securlan: ${sectorName}.`);
            }
            else {
                accessory.context.displayName = sectorName;
                accessory.context.alarmSector = sector;
                this.configureHapAccessory(accessory);
            }
            this.updateAlarmSectorAccessory(accessory, sector);
        }
        const systemUuid = this.api.hap.uuid.generate(`${settings_1.PLUGIN_NAME}:alarm:system`);
        if (this.config.alarm?.removeMissing || this.cachedAccessories.has(systemUuid)) {
            this.removeMissingAlarmAccessories(seenIds);
        }
    }
    async refreshOutputs() {
        const discoveredOutputs = this.config.discoverOutputs === false || !this.client
            ? []
            : await this.client.getOutputs();
        const outputs = this.mergeOutputs(discoveredOutputs);
        const seenIds = new Set();
        for (const output of outputs) {
            if (output.enabled === false) {
                continue;
            }
            const outputName = output.displayName ?? output.name ?? `Uscita ${(output.idIndex ?? 0) + 1}`;
            const outputStableId = output.idIndex !== undefined
                ? `index:${output.idIndex}`
                : output.name ?? output.id ?? outputName;
            const id = `output:${normalizeId(outputStableId)}`;
            seenIds.add(id);
            const uuid = this.api.hap.uuid.generate(`${settings_1.PLUGIN_NAME}:${id}`);
            let accessory = this.cachedAccessories.get(uuid);
            if (!accessory) {
                accessory = new this.api.platformAccessory(outputName, uuid);
                accessory.context = {
                    kind: 'output',
                    id,
                    displayName: outputName,
                    output,
                    outputMode: resolveOutputMode(output, this.config.defaultOutputMode),
                    linkedSensorId: output.linkedSensorId,
                    linkedSensorName: output.linkedSensorName,
                };
                this.configureHapAccessory(accessory);
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
                this.cachedAccessories.set(uuid, accessory);
                this.log.info(`Nuova uscita Securlan: ${outputName} (${accessory.context.outputMode}).`);
            }
            else {
                accessory.context.output = output;
                accessory.context.displayName = outputName;
                accessory.context.outputMode = resolveOutputMode(output, this.config.defaultOutputMode);
                accessory.context.linkedSensorId = output.linkedSensorId;
                accessory.context.linkedSensorName = output.linkedSensorName;
                this.configureHapAccessory(accessory);
            }
        }
        if (this.config.removeMissingOutputs) {
            this.removeMissingOutputAccessories(seenIds);
        }
        await this.registerMatterOutputs();
    }
    getOrCreateSensorAccessory(sensor) {
        const override = this.config.sensors?.overrides?.find(item => item.name === sensor.name);
        const sensorKind = resolveSensorKind(sensor.name, override?.kind);
        const displayName = override?.displayName ?? sensor.name;
        const id = `sensor:${normalizeId(sensor.name)}`;
        const uuid = this.api.hap.uuid.generate(`${settings_1.PLUGIN_NAME}:${id}`);
        let accessory = this.cachedAccessories.get(uuid);
        if (!accessory) {
            accessory = new this.api.platformAccessory(displayName, uuid);
            accessory.context = {
                kind: 'sensor',
                id,
                displayName,
                sensorKind,
            };
            this.configureHapAccessory(accessory);
            this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [accessory]);
            this.cachedAccessories.set(uuid, accessory);
            this.log.info(`Nuovo sensore Securlan: ${displayName} (${sensorKind}).`);
        }
        else {
            accessory.context.displayName = displayName;
            accessory.context.sensorKind = sensorKind;
        }
        return accessory;
    }
    configureHapAccessory(accessory) {
        const info = accessory.getService(this.Service.AccessoryInformation)
            ?? accessory.addService(this.Service.AccessoryInformation);
        info
            .setCharacteristic(this.Characteristic.Manufacturer, 'Securlan')
            .setCharacteristic(this.Characteristic.Model, 'CWebForce')
            .setCharacteristic(this.Characteristic.SerialNumber, accessory.context.id);
        if (accessory.context.kind === 'alarm') {
            this.configureAlarmAccessory(accessory);
        }
        else if (accessory.context.kind === 'output') {
            this.configureOutputAccessory(accessory);
        }
        else {
            this.configureSensorAccessory(accessory);
        }
    }
    configureAlarmAccessory(accessory) {
        if (accessory.context.alarmSectors) {
            this.configureAlarmSystemAccessory(accessory);
            return;
        }
        this.configureAlarmSectorAccessory(accessory);
    }
    configureAlarmSystemAccessory(accessory) {
        const service = accessory.getService(this.Service.SecuritySystem)
            ?? accessory.addService(this.Service.SecuritySystem, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
        service.getCharacteristic(this.Characteristic.SecuritySystemTargetState)
            .onSet(async (value) => {
            if (!this.client || !accessory.context.alarmSectors) {
                throw new Error('Securlan client non configurato.');
            }
            if (!this.config.alarm?.allowControl) {
                throw new Error('Comandi allarme Securlan disabilitati. Imposta alarm.allowControl=true per abilitarli.');
            }
            const targetStates = this.resolveAlarmSystemTargetStates(value, accessory.context.alarmSectors);
            this.log.info(`Cambio stato allarme Securlan ${accessory.context.displayName}.`);
            await this.client.setAlarmSectors(targetStates);
            await this.refreshAlarmSectors();
        })
            .onGet(() => this.alarmSystemTargetState(accessory.context.alarmSectors ?? []));
        this.updateAlarmSystemAccessory(accessory, accessory.context.alarmSectors ?? []);
    }
    configureAlarmSectorAccessory(accessory) {
        const service = accessory.getService(this.Service.SecuritySystem)
            ?? accessory.addService(this.Service.SecuritySystem, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
        service.getCharacteristic(this.Characteristic.SecuritySystemTargetState)
            .onSet(async (value) => {
            if (!this.client || !accessory.context.alarmSector) {
                throw new Error('Securlan client non configurato.');
            }
            if (!this.config.alarm?.allowControl) {
                throw new Error('Comandi allarme Securlan disabilitati. Imposta alarm.allowControl=true per abilitarli.');
            }
            const targetArmed = value !== this.Characteristic.SecuritySystemTargetState.DISARM;
            const sector = accessory.context.alarmSector;
            this.log.info(`${targetArmed ? 'Inserimento' : 'Disinserimento'} settore allarme Securlan ${sector.name}.`);
            await this.client.setAlarmSectors({ [sector.id]: targetArmed });
            await this.refreshAlarmSectors();
        })
            .onGet(() => this.alarmSectorTargetState(accessory.context.alarmSector?.armed ?? false));
        this.updateAlarmSectorAccessory(accessory, accessory.context.alarmSector);
    }
    configureOutputAccessory(accessory) {
        const mode = accessory.context.outputMode ?? 'button';
        if (mode === 'garageDoor') {
            this.configureGarageDoorAccessory(accessory);
            return;
        }
        if (mode === 'windowCovering') {
            this.configureWindowCoveringAccessory(accessory);
            return;
        }
        if (mode === 'lock') {
            this.configureLockAccessory(accessory);
            return;
        }
        this.removeServiceIfPresent(accessory, this.Service.GarageDoorOpener);
        this.removeServiceIfPresent(accessory, this.Service.WindowCovering);
        this.removeServiceIfPresent(accessory, this.Service.LockMechanism);
        this.removeServiceIfPresent(accessory, this.Service.Switch);
        const service = accessory.addService(this.Service.Switch, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
        service.getCharacteristic(this.Characteristic.On)
            .onSet(async (value) => {
            if (value !== true || !this.client || !accessory.context.output) {
                return;
            }
            await this.client.triggerOutput(accessory.context.output);
            const pulseSeconds = accessory.context.output.pulseSeconds ?? 1;
            void this.pulseMatterOutputState(accessory.UUID, pulseSeconds);
            setTimeout(() => {
                service.updateCharacteristic(this.Characteristic.On, false);
            }, pulseSeconds * 1000);
        })
            .onGet(() => false);
    }
    configureGarageDoorAccessory(accessory) {
        this.removeServiceIfPresent(accessory, this.Service.Switch);
        this.removeServiceIfPresent(accessory, this.Service.WindowCovering);
        this.removeServiceIfPresent(accessory, this.Service.LockMechanism);
        this.removeServiceIfPresent(accessory, this.Service.GarageDoorOpener);
        const service = accessory.addService(this.Service.GarageDoorOpener, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
        service.getCharacteristic(this.Characteristic.TargetDoorState)
            .onSet(async (value) => {
            if (!this.client || !accessory.context.output) {
                return;
            }
            const currentState = this.resolveLinkedContactOpen(accessory);
            const targetOpen = value === this.Characteristic.TargetDoorState.OPEN;
            if (currentState !== undefined && currentState === targetOpen) {
                return;
            }
            await this.client.triggerOutput(accessory.context.output);
            service.updateCharacteristic(this.Characteristic.CurrentDoorState, targetOpen
                ? this.Characteristic.CurrentDoorState.OPENING
                : this.Characteristic.CurrentDoorState.CLOSING);
        })
            .onGet(() => {
            const currentState = this.resolveLinkedContactOpen(accessory);
            return currentState === false
                ? this.Characteristic.TargetDoorState.CLOSED
                : this.Characteristic.TargetDoorState.OPEN;
        });
        this.updateGarageDoorAccessory(accessory);
    }
    configureWindowCoveringAccessory(accessory) {
        this.removeServiceIfPresent(accessory, this.Service.Switch);
        this.removeServiceIfPresent(accessory, this.Service.GarageDoorOpener);
        this.removeServiceIfPresent(accessory, this.Service.LockMechanism);
        this.removeServiceIfPresent(accessory, this.Service.WindowCovering);
        const service = accessory.addService(this.Service.WindowCovering, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
        service.getCharacteristic(this.Characteristic.TargetPosition)
            .onSet(async (value) => {
            if (!this.client || !accessory.context.output || typeof value !== 'number') {
                return;
            }
            const currentPosition = this.resolveLinkedPosition(accessory);
            const targetPosition = value >= 50 ? 100 : 0;
            accessory.context.lastTargetPosition = targetPosition;
            service.updateCharacteristic(this.Characteristic.TargetPosition, targetPosition);
            if (currentPosition !== undefined && currentPosition === targetPosition) {
                return;
            }
            await this.client.triggerOutput(accessory.context.output);
            service.updateCharacteristic(this.Characteristic.PositionState, targetPosition > (currentPosition ?? 0)
                ? this.Characteristic.PositionState.INCREASING
                : this.Characteristic.PositionState.DECREASING);
            const pulseSeconds = accessory.context.output.pulseSeconds ?? 1;
            setTimeout(() => {
                service.updateCharacteristic(this.Characteristic.PositionState, this.Characteristic.PositionState.STOPPED);
            }, pulseSeconds * 1000);
        })
            .onGet(() => accessory.context.lastTargetPosition ?? this.resolveLinkedPosition(accessory) ?? 0);
        this.updateWindowCoveringAccessory(accessory);
    }
    configureLockAccessory(accessory) {
        this.removeServiceIfPresent(accessory, this.Service.Switch);
        this.removeServiceIfPresent(accessory, this.Service.GarageDoorOpener);
        this.removeServiceIfPresent(accessory, this.Service.WindowCovering);
        this.removeServiceIfPresent(accessory, this.Service.LockMechanism);
        const service = accessory.addService(this.Service.LockMechanism, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
        service.getCharacteristic(this.Characteristic.LockTargetState)
            .onSet(async (value) => {
            if (!this.client || !accessory.context.output) {
                return;
            }
            if (value === this.Characteristic.LockTargetState.SECURED) {
                this.updateLockAccessory(accessory);
                return;
            }
            const currentlyOpen = this.resolveLinkedContactOpen(accessory);
            if (currentlyOpen === true) {
                return;
            }
            await this.client.triggerOutput(accessory.context.output);
            this.showTemporaryUnlockedState(accessory);
        })
            .onGet(() => this.lockTargetState(accessory));
        this.updateLockAccessory(accessory);
    }
    configureSensorAccessory(accessory) {
        const kind = accessory.context.sensorKind ?? 'contact';
        if (kind === 'motion') {
            this.removeServiceIfPresent(accessory, this.Service.ContactSensor);
            this.removeServiceIfPresent(accessory, this.Service.OccupancySensor);
            const service = accessory.getService(this.Service.MotionSensor)
                ?? accessory.addService(this.Service.MotionSensor, accessory.context.displayName);
            service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
            return;
        }
        if (kind === 'occupancy') {
            this.removeServiceIfPresent(accessory, this.Service.ContactSensor);
            this.removeServiceIfPresent(accessory, this.Service.MotionSensor);
            const service = accessory.getService(this.Service.OccupancySensor)
                ?? accessory.addService(this.Service.OccupancySensor, accessory.context.displayName);
            service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
            return;
        }
        this.removeServiceIfPresent(accessory, this.Service.MotionSensor);
        this.removeServiceIfPresent(accessory, this.Service.OccupancySensor);
        const service = accessory.getService(this.Service.ContactSensor)
            ?? accessory.addService(this.Service.ContactSensor, accessory.context.displayName);
        service.setCharacteristic(this.Characteristic.Name, accessory.context.displayName);
    }
    updateSensorAccessory(accessory, sensor) {
        const kind = accessory.context.sensorKind ?? 'contact';
        if (kind === 'motion') {
            const active = sensorIsOpen(sensor);
            accessory.getService(this.Service.MotionSensor)
                ?.updateCharacteristic(this.Characteristic.MotionDetected, active);
            return;
        }
        if (kind === 'occupancy') {
            const occupied = sensorIsOpen(sensor);
            accessory.getService(this.Service.OccupancySensor)
                ?.updateCharacteristic(this.Characteristic.OccupancyDetected, occupied);
            return;
        }
        const contactState = sensorIsClosed(sensor)
            ? this.Characteristic.ContactSensorState.CONTACT_DETECTED
            : this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
        accessory.getService(this.Service.ContactSensor)
            ?.updateCharacteristic(this.Characteristic.ContactSensorState, contactState);
    }
    updateLinkedOutputAccessories() {
        for (const accessory of this.cachedAccessories.values()) {
            if (accessory.context.kind !== 'output') {
                continue;
            }
            if (accessory.context.outputMode === 'garageDoor') {
                this.updateGarageDoorAccessory(accessory);
            }
            else if (accessory.context.outputMode === 'windowCovering') {
                this.updateWindowCoveringAccessory(accessory);
            }
            else if (accessory.context.outputMode === 'lock') {
                this.updateLockAccessory(accessory);
            }
        }
    }
    updateAlarmSectorAccessory(accessory, sector) {
        const service = accessory.getService(this.Service.SecuritySystem);
        if (!service || !sector) {
            return;
        }
        service.updateCharacteristic(this.Characteristic.SecuritySystemCurrentState, this.alarmSectorCurrentState(sector.armed));
        service.updateCharacteristic(this.Characteristic.SecuritySystemTargetState, this.alarmSectorTargetState(sector.armed));
    }
    updateAlarmSystemAccessory(accessory, sectors) {
        const service = accessory.getService(this.Service.SecuritySystem);
        if (!service) {
            return;
        }
        const currentState = this.alarmSystemCurrentState(sectors);
        service.updateCharacteristic(this.Characteristic.SecuritySystemCurrentState, currentState);
        service.updateCharacteristic(this.Characteristic.SecuritySystemTargetState, alarmCurrentToTargetState(this.Characteristic, currentState));
    }
    alarmSectorCurrentState(armed) {
        return armed
            ? this.Characteristic.SecuritySystemCurrentState.AWAY_ARM
            : this.Characteristic.SecuritySystemCurrentState.DISARMED;
    }
    alarmSectorTargetState(armed) {
        return armed
            ? this.Characteristic.SecuritySystemTargetState.AWAY_ARM
            : this.Characteristic.SecuritySystemTargetState.DISARM;
    }
    alarmSystemCurrentState(sectors) {
        const armedIds = new Set(sectors.filter(sector => sector.armed).map(sector => normalizeSectorId(sector.id)));
        if (armedIds.size === 0) {
            return this.Characteristic.SecuritySystemCurrentState.DISARMED;
        }
        if (sameSectorSet(armedIds, this.resolveAlarmModeSectorIds('away', sectors))) {
            return this.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
        }
        if (sameSectorSet(armedIds, this.resolveAlarmModeSectorIds('home', sectors))) {
            return this.Characteristic.SecuritySystemCurrentState.STAY_ARM;
        }
        if (sameSectorSet(armedIds, this.resolveAlarmModeSectorIds('night', sectors))) {
            return this.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
        }
        return this.Characteristic.SecuritySystemCurrentState.AWAY_ARM;
    }
    alarmSystemTargetState(sectors) {
        return alarmCurrentToTargetState(this.Characteristic, this.alarmSystemCurrentState(sectors));
    }
    resolveAlarmSystemTargetStates(targetState, sectors) {
        const managedIds = this.resolveManagedAlarmSectorIds(sectors);
        const targetIds = targetState === this.Characteristic.SecuritySystemTargetState.DISARM
            ? new Set()
            : this.resolveAlarmModeSectorIds(targetStateToAlarmMode(this.Characteristic, targetState), sectors);
        const states = {};
        for (const id of managedIds) {
            states[id] = targetIds.has(id);
        }
        return states;
    }
    resolveManagedAlarmSectorIds(sectors) {
        const configuredModes = this.config.alarm?.modes;
        const configuredIds = [
            ...(configuredModes?.away ?? []),
            ...(configuredModes?.home ?? []),
            ...(configuredModes?.night ?? []),
        ].map(normalizeSectorId);
        return new Set(configuredIds.length > 0
            ? configuredIds
            : sectors.map(sector => normalizeSectorId(sector.id)));
    }
    resolveAlarmModeSectorIds(mode, sectors) {
        const configured = this.config.alarm?.modes?.[mode];
        if (configured) {
            return new Set(configured.map(normalizeSectorId));
        }
        if (mode !== 'away') {
            return this.resolveAlarmModeSectorIds('away', sectors);
        }
        return new Set(sectors.map(sector => normalizeSectorId(sector.id)));
    }
    updateGarageDoorAccessory(accessory) {
        const service = accessory.getService(this.Service.GarageDoorOpener);
        if (!service) {
            return;
        }
        const isOpen = this.resolveLinkedContactOpen(accessory);
        const currentState = isOpen === undefined
            ? this.Characteristic.CurrentDoorState.STOPPED
            : isOpen
                ? this.Characteristic.CurrentDoorState.OPEN
                : this.Characteristic.CurrentDoorState.CLOSED;
        const targetState = isOpen === false
            ? this.Characteristic.TargetDoorState.CLOSED
            : this.Characteristic.TargetDoorState.OPEN;
        service.updateCharacteristic(this.Characteristic.CurrentDoorState, currentState);
        service.updateCharacteristic(this.Characteristic.TargetDoorState, targetState);
    }
    updateWindowCoveringAccessory(accessory) {
        const service = accessory.getService(this.Service.WindowCovering);
        if (!service) {
            return;
        }
        const position = this.resolveLinkedPosition(accessory);
        if (position === undefined) {
            service.updateCharacteristic(this.Characteristic.PositionState, this.Characteristic.PositionState.STOPPED);
            return;
        }
        accessory.context.lastTargetPosition = position;
        service.updateCharacteristic(this.Characteristic.CurrentPosition, position);
        service.updateCharacteristic(this.Characteristic.TargetPosition, position);
        service.updateCharacteristic(this.Characteristic.PositionState, this.Characteristic.PositionState.STOPPED);
    }
    updateLockAccessory(accessory) {
        const service = accessory.getService(this.Service.LockMechanism);
        if (!service) {
            return;
        }
        const isOpen = this.resolveLinkedContactOpen(accessory);
        if (isOpen === undefined && this.lockResetTimers.has(accessory.UUID)) {
            return;
        }
        if (isOpen !== undefined) {
            const existingTimer = this.lockResetTimers.get(accessory.UUID);
            if (existingTimer) {
                clearTimeout(existingTimer);
                this.lockResetTimers.delete(accessory.UUID);
            }
        }
        const currentState = isOpen === undefined
            ? this.Characteristic.LockCurrentState.SECURED
            : isOpen
                ? this.Characteristic.LockCurrentState.UNSECURED
                : this.Characteristic.LockCurrentState.SECURED;
        const targetState = currentState === this.Characteristic.LockCurrentState.UNSECURED
            ? this.Characteristic.LockTargetState.UNSECURED
            : this.Characteristic.LockTargetState.SECURED;
        service.updateCharacteristic(this.Characteristic.LockCurrentState, currentState);
        service.updateCharacteristic(this.Characteristic.LockTargetState, targetState);
    }
    showTemporaryUnlockedState(accessory) {
        const service = accessory.getService(this.Service.LockMechanism);
        if (!service) {
            return;
        }
        const existingTimer = this.lockResetTimers.get(accessory.UUID);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.UNSECURED);
        service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.UNSECURED);
        if (this.resolveLinkedContactOpen(accessory) !== undefined) {
            return;
        }
        const pulseSeconds = accessory.context.output?.pulseSeconds ?? 1;
        const timer = setTimeout(() => {
            service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
            service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
            this.lockResetTimers.delete(accessory.UUID);
        }, pulseSeconds * 1000);
        this.lockResetTimers.set(accessory.UUID, timer);
    }
    lockTargetState(accessory) {
        const isOpen = this.resolveLinkedContactOpen(accessory);
        return isOpen === true
            ? this.Characteristic.LockTargetState.UNSECURED
            : this.Characteristic.LockTargetState.SECURED;
    }
    removeMissingSensorAccessories(seenIds) {
        const stale = [];
        for (const accessory of this.cachedAccessories.values()) {
            if (accessory.context.kind === 'sensor' && !seenIds.has(accessory.context.id)) {
                stale.push(accessory);
            }
        }
        if (stale.length > 0) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
            stale.forEach(accessory => this.cachedAccessories.delete(accessory.UUID));
        }
    }
    removeMissingOutputAccessories(seenIds) {
        const stale = [];
        for (const accessory of this.cachedAccessories.values()) {
            if (accessory.context.kind === 'output' && !seenIds.has(accessory.context.id)) {
                stale.push(accessory);
            }
        }
        if (stale.length > 0) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
            stale.forEach(accessory => this.cachedAccessories.delete(accessory.UUID));
        }
    }
    removeMissingAlarmAccessories(seenIds) {
        const stale = [];
        for (const accessory of this.cachedAccessories.values()) {
            if (accessory.context.kind === 'alarm' && !seenIds.has(accessory.context.id)) {
                stale.push(accessory);
            }
        }
        if (stale.length > 0) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, stale);
            stale.forEach(accessory => this.cachedAccessories.delete(accessory.UUID));
        }
    }
    mergeOutputs(discoveredOutputs) {
        const overrides = this.config.outputs ?? [];
        const outputs = discoveredOutputs.map(discovered => {
            const override = findOutputOverride(discovered, overrides);
            return {
                id: discovered.id,
                idIndex: discovered.idIndex,
                name: discovered.name,
                ...override,
                displayName: override?.displayName ?? override?.name ?? discovered.name,
            };
        });
        for (const override of overrides) {
            const alreadyMerged = outputs.some(output => outputOverrideMatches(output, override));
            if (!alreadyMerged) {
                outputs.push(override);
            }
        }
        return outputs;
    }
    mergeAlarmSectors(discoveredSectors) {
        const overrides = this.config.alarm?.sectors ?? [];
        return discoveredSectors.map(sector => {
            const override = findAlarmSectorOverride(sector, overrides);
            return {
                ...sector,
                ...override,
                displayName: override?.displayName ?? override?.name ?? sector.name,
            };
        });
    }
    resolveLinkedContactOpen(accessory) {
        const output = accessory.context.output;
        const sensor = this.findLinkedSensor(accessory);
        if (!sensor) {
            if (accessory.context.outputMode === 'garageDoor' || accessory.context.outputMode === 'windowCovering' || accessory.context.outputMode === 'lock') {
                this.log.debug(`Output ${accessory.context.displayName} non ha ancora un sensore associato disponibile.`);
            }
            return undefined;
        }
        const openState = normalizeState(output?.sensorOpenState ?? 'APERTO');
        const closedState = normalizeState(output?.sensorClosedState ?? 'PRONTO');
        if (sensor.rawState === openState) {
            return true;
        }
        if (sensor.rawState === closedState) {
            return false;
        }
        return sensorIsOpen(sensor);
    }
    resolveLinkedPosition(accessory) {
        const isOpen = this.resolveLinkedContactOpen(accessory);
        if (isOpen === undefined) {
            return undefined;
        }
        return isOpen ? 100 : 0;
    }
    findLinkedSensor(accessory) {
        const linkedSensorId = accessory.context.linkedSensorId;
        const linkedSensorName = accessory.context.linkedSensorName;
        if (linkedSensorId) {
            const normalizedId = linkedSensorId.startsWith('sensor:')
                ? linkedSensorId
                : `sensor:${normalizeId(linkedSensorId)}`;
            const sensor = this.sensorStatesById.get(normalizedId);
            if (sensor) {
                return sensor;
            }
        }
        if (linkedSensorName) {
            return this.sensorStatesByName.get(linkedSensorName);
        }
        return undefined;
    }
    removeServiceIfPresent(accessory, serviceType) {
        const services = accessory.services.filter(service => service.UUID === serviceType.UUID);
        for (const service of services) {
            accessory.removeService(service);
        }
    }
    async registerMatterOutputs() {
        if (this.matterOutputsPrepared || !this.config.matter?.exposeOutputs || !this.api.isMatterEnabled() || !this.api.matter) {
            return;
        }
        const matter = this.api.matter;
        const onOffDeviceType = matter.deviceTypes?.OnOffOutlet
            ?? matter.deviceTypes?.OnOffPlugInUnit
            ?? matter.deviceTypes?.OnOffLight;
        if (!onOffDeviceType || !matter.registerPlatformAccessories) {
            this.log.warn('Matter e abilitato, ma il device type OnOff non e disponibile in questa versione Homebridge.');
            return;
        }
        const outputs = [...this.cachedAccessories.values()]
            .filter(accessory => accessory.context.kind === 'output')
            .filter(accessory => ['button', 'switch'].includes(accessory.context.outputMode ?? 'button'))
            .map(accessory => this.createMatterOutputAccessory(accessory, onOffDeviceType));
        const newOutputs = [];
        for (const output of outputs) {
            const cached = this.cachedMatterAccessories.get(output.UUID);
            if (cached) {
                Object.assign(cached, output);
            }
            else {
                newOutputs.push(output);
            }
        }
        if (newOutputs.length > 0) {
            await matter.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, newOutputs);
        }
        this.matterOutputsPrepared = true;
    }
    createMatterOutputAccessory(accessory, deviceType) {
        return {
            UUID: accessory.UUID,
            displayName: accessory.context.displayName,
            deviceType,
            manufacturer: 'Securlan',
            model: 'CWebForce Output',
            serialNumber: accessory.context.id,
            context: accessory.context,
            clusters: {
                onOff: {
                    onOff: false,
                },
            },
            handlers: {
                onOff: {
                    on: async () => {
                        if (!this.client || !accessory.context.output) {
                            throw new Error('Securlan client non configurato.');
                        }
                        await this.client.triggerOutput(accessory.context.output);
                        const pulseSeconds = accessory.context.output.pulseSeconds ?? 1;
                        setTimeout(() => {
                            void this.pulseMatterOutputState(accessory.UUID, pulseSeconds, false);
                        }, pulseSeconds * 1000);
                    },
                    off: async () => undefined,
                },
            },
        };
    }
    async pulseMatterOutputState(uuid, pulseSeconds, turnOn = true) {
        const matter = this.api.matter;
        if (!this.config.matter?.exposeOutputs || !this.api.isMatterEnabled() || !matter?.updateAccessoryState) {
            return;
        }
        if (turnOn) {
            await matter.updateAccessoryState(uuid, 'onOff', { onOff: true });
            setTimeout(() => {
                void matter.updateAccessoryState?.(uuid, 'onOff', { onOff: false });
            }, pulseSeconds * 1000);
            return;
        }
        await matter.updateAccessoryState(uuid, 'onOff', { onOff: false });
    }
}
exports.SecurlanPlatform = SecurlanPlatform;
function resolveSensorKind(name, override) {
    if (override && override !== 'auto') {
        return override;
    }
    return /\b(IR|VX|SENSORE)\b/i.test(name) ? 'motion' : 'contact';
}
function resolveOutputMode(output, defaultMode) {
    return output.exposeAs ?? defaultMode ?? 'button';
}
function findOutputOverride(discovered, overrides) {
    return overrides.find(override => outputOverrideMatches(discovered, override));
}
function outputOverrideMatches(discovered, override) {
    if (override.id && discovered.id === override.id) {
        return true;
    }
    if (override.idIndex !== undefined && discovered.idIndex === override.idIndex) {
        return true;
    }
    if (override.name && discovered.name && normalizeComparable(discovered.name) === normalizeComparable(override.name)) {
        return true;
    }
    return false;
}
function findAlarmSectorOverride(discovered, overrides) {
    return overrides.find(override => {
        if (override.id && normalizeSectorId(override.id) === normalizeSectorId(discovered.id)) {
            return true;
        }
        if (override.name && normalizeComparable(override.name) === normalizeComparable(discovered.name)) {
            return true;
        }
        return false;
    });
}
function normalizeSectorId(value) {
    const numeric = value.replace(/^A/i, '').replace(/[^0-9]/g, '');
    return numeric.padStart(3, '0');
}
function sameSectorSet(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const value of left) {
        if (!right.has(value)) {
            return false;
        }
    }
    return true;
}
function alarmCurrentToTargetState(characteristic, currentState) {
    if (currentState === characteristic.SecuritySystemCurrentState.STAY_ARM) {
        return characteristic.SecuritySystemTargetState.STAY_ARM;
    }
    if (currentState === characteristic.SecuritySystemCurrentState.NIGHT_ARM) {
        return characteristic.SecuritySystemTargetState.NIGHT_ARM;
    }
    if (currentState === characteristic.SecuritySystemCurrentState.DISARMED) {
        return characteristic.SecuritySystemTargetState.DISARM;
    }
    return characteristic.SecuritySystemTargetState.AWAY_ARM;
}
function targetStateToAlarmMode(characteristic, targetState) {
    if (targetState === characteristic.SecuritySystemTargetState.STAY_ARM) {
        return 'home';
    }
    if (targetState === characteristic.SecuritySystemTargetState.NIGHT_ARM) {
        return 'night';
    }
    return 'away';
}
function sensorIsOpen(sensor) {
    return sensor.rawState === 'APERTO';
}
function sensorIsClosed(sensor) {
    return sensor.rawState === 'PRONTO';
}
function normalizeState(value) {
    return value.trim().toUpperCase();
}
function normalizeId(value) {
    return value
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function normalizeComparable(value) {
    return normalizeId(value).replaceAll('-', ' ');
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
