'use strict';

const utils = require('@iobroker/adapter-core');
const tjs = require('teslajs');

class TeslaMotors extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options){
        super({
            ...options,
            name: 'tesla-motors',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.distanceUnit = 'km/hr';
        this.WakeItUpRetryCount = 30;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady(){ //
        const Adapter = this;

        Adapter.initCommandObjects();
        this.subscribeStates('command.*');
        this.log.debug('Starting Tesla Motors');
        await Adapter.setStateAsync('info.connection', false, true);

        Adapter.log.debug("Check for Tokens and Expires");

        let Expires = new Date(Adapter.config.tokenExpire);
        Expires.setDate(Expires.getDate() - 10);

        if(Adapter.config.authToken.length === 0){
            await this.GetNewToken();
        }
        else if(Expires < new Date()){
            await this.RefreshToken();
        }
        else{
            await Adapter.setStateAsync('info.connection', true, true);
            Adapter.log.debug("Connected to Tesla");
        }
        await Adapter.GetSleepingInfo();
        await Adapter.GetAllInfo();
        Adapter.log.debug("Everything initialized, starting Intervals");
        setInterval(() => {
            Adapter.RefreshToken();
        }, 24 * 60 * 60 * 1000);

        setInterval(() => {
            Adapter.GetSleepingInfo();
        }, 1 * 60 * 1000);

        setInterval(() => {
            Adapter.GetAllInfo();
        }, 1 * 60 * 1000) // Todo: Make configurable and do the update more often when car is moving
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     */
    onUnload(callback){
        try{
            this.log.info('cleaned everything up...');
            callback();
        }catch(e){
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state){
        const Adapter = this;
        if(!state) return;
        Adapter.log.debug("State Change: " + id + " to " + state.val + " ack " + state.ack);

        const State = await Adapter.getStateAsync('info.connection');
        if(!State || !State.val){
            Adapter.log.warn('You tried to set a State, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        let options = {
            authToken: Adapter.config.authToken,
            vehicleID: Adapter.config.vehicle_id_s
        };
        const currentId = id.substring(Adapter.namespace.length + 1);
        if(state && !state.ack){
            let requestDataChange = true;
            await Adapter.WakeItUp();
            switch(currentId){
                case 'command.awake':
                    if(state.val){
                        await tjs.wakeUpAsync(options);
                    }
                    break;
                case 'command.doorLock':
                    if(state.val){
                        await tjs.doorLockAsync(options);
                    }
                    else{
                        await tjs.doorUnlockAsync(options);
                    }
                    break;
                case 'command.honkHorn':
                    if(state.val){
                        await tjs.honkHornAsync(options);
                        Adapter.setState('command.honkHorn', false, true);
                        requestDataChange = false;
                    }
                    break;
                case 'command.Climate':
                    if(state.val){
                        await tjs.climateStartAsync(options);
                    }
                    else{
                        await tjs.climateStopAsync(options);
                    }
                    break;
                case 'command.SetTemperature':
                    let minTemp = await Adapter.getStateAsync('climateState.min_avail_temp');
                    let maxTemp = await Adapter.getStateAsync('climateState.max_avail_temp');
                    if(!minTemp || !maxTemp){
                        Adapter.log.warn('Min and Max temp do not exists!');
                    }
                    else{
                        if(state.val > maxTemp.val) state.val = maxTemp.val;
                        if(state.val < minTemp.val) state.val = minTemp.val;
                    }
                    await tjs.setTempsAsync(options, state.val, state.val);
                    break;
                case 'command.SetChargeLimit':
                    if(parseInt(state.val) > 100 || parseInt(state.val) < 0){
                        Adapter.setState('command.SetChargeLimit', 80, true);
                    }
                    else await tjs.setChargeLimitAsync(options, state.val);
                    break;
                case 'command.ChargePort':
                    if(state.val){
                        await tjs.openChargePortAsync(options);
                    }
                    else{
                        await tjs.closeChargePortAsync(options);
                    }
                    break;
                case 'command.Charging':
                    if(state.val){
                        await tjs.startChargeAsync(options);
                    }
                    else{
                        await tjs.stopChargeAsync(options);
                    }
                    break;
                case 'command.ValetMode':
                    const ValetPin = await Adapter.getStateAsync('command.ValetPin');
                    if(!ValetPin){
                        Adapter.setStateCreate('command.ValetPin', '????');
                        break;
                    }
                    if(/^\d{4}$/.test(ValetPin.val)){
                        await tjs.setValetModeAsync(options, state.val, ValetPin.val);
                    }
                    else{
                        if(!state.val){ // Ensure valet mode is off anyway!
                            await tjs.setValetModeAsync(options, false, '0000');
                            await tjs.resetValetPinAsync(options);
                        }
                        Adapter.setState('command.ValetPin', '????');
                    }
                    break;
                case 'command.SpeedLimit':
                    if(state.val){
                        await tjs.speedLimitActivateAsync(options);
                    }
                    else{
                        await tjs.speedLimitDeactivateAsync(options);
                    }
                    break;
                case 'command.SpeedLimitValue':
                    let min = await Adapter.getStateAsync('driveState.SpeedLimitMin');
                    let max = await Adapter.getStateAsync('driveState.SpeedLimitMax');
                    if(!min || !max){
                        Adapter.log.warn('Min and Max Speed do not exists!');
                    }
                    else{
                        if(state.val > max.val) state.val = max.val;
                        if(state.val < min.val) state.val = min.val;
                    }
                    await tjs.speedLimitSetLimitAsync(options, Adapter.km_m(state.val));
                    break;
                case 'command.SentryMode':
                    await tjs.setSentryModeAsync(options, state.val);
                    break;
                case 'command.RemoteStart':
                    await tjs.remoteStartAsync(options, state.val);
                    break;
                case 'command.SunRoofVent':
                    await tjs.sunRoofControlAsync(options, state.val ? "vent" : "close");
                    break;
                case 'command.StartSoftwareUpdate':
                    await tjs.scheduleSoftwareUpdateAsync(options, 0);
                    break;
                case 'command.seat_heater_left':
                    if(state.val < 0) state.val = 0;
                    if(state.val > 3) state.val = 3;
                    await tjs.seatHeaterAsync(options, 0, state.val);
                    break;
                case 'command.seat_heater_right':
                    if(state.val < 0) state.val = 0;
                    if(state.val > 3) state.val = 3;
                    await tjs.seatHeaterAsync(options, 1, state.val);
                    break;
                case 'command.seat_heater_rear_center':
                    if(state.val < 0) state.val = 0;
                    if(state.val > 3) state.val = 3;
                    await tjs.seatHeaterAsync(options, 4, state.val);
                    break;
                case 'command.seat_heater_rear_left':
                    if(state.val < 0) state.val = 0;
                    if(state.val > 3) state.val = 3;
                    await tjs.seatHeaterAsync(options, 2, state.val);
                    break;
                case 'command.seat_heater_rear_right':
                    if(state.val < 0) state.val = 0;
                    if(state.val > 3) state.val = 3;
                    await tjs.seatHeaterAsync(options, 5, state.val);
                    break;
                case 'command.steering_wheel_heater':
                    await tjs.steeringHeaterAsync(options, state.val ? 3 : 0);
                    break;
                case 'command.windowVent':
                    await tjs.windowControlAsync(options, state.val ? 'vent' : 'close');
                    break;
                case 'command.openTrunk':
                    await tjs.openTrunkAsync(options, 'front');
                    requestDataChange = false;
                    break;
                case 'command.openFrunk':
                    await tjs.openTrunkAsync(options, 'rear');
                    requestDataChange = false;
                    break;
                default:
                    requestDataChange = false;
                    break;
            }
            if(requestDataChange){
                await Adapter.GetAllInfo();
            }
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        }
    }

    async onMessage(msg){
        const Adapter = this;
        Adapter.log.debug('Got a Message: ' + msg.command);
        if(msg.command === 'getToken'){
            // Get a Token
            let username = msg.message.teslaUsername;
            let password = msg.message.teslaPassword;
            Adapter.log.info('Try to get a token');

            let Response = await new Promise(async resolve => {
                tjs.login(username, password, async (err, result) => {
                    if(result.error || !result.authToken){
                        Adapter.log.info('Username or Password invalid' + result.body.response);
                        await Adapter.setStateAsync('info.connection', false, true);
                        resolve({
                            error: true,
                            msg: 'Could not retrieve token, Error from Tesla: ' + result.body.response
                        });
                        return;
                    }
                    Adapter.log.info('Received a new Token');
                    let ExpireDate = new Date();
                    ExpireDate.setSeconds(ExpireDate.getSeconds() + result.body.expires_in);
                    await Adapter.setStateAsync('info.connection', true, true);
                    resolve({
                        error: false,
                        authToken: result.authToken,
                        refreshToken: result.refreshToken,
                        tokenExpire: ExpireDate.getTime(),
                        msg: 'Success'
                    });
                });
            });
            let Vehicles = {};
            if(!Response.error){
                Vehicles = await new Promise(async resolve => {
                    let options = {authToken: Response.authToken};
                    tjs.vehicles(options, (err, vehicles) => {
                        if(err){
                            Adapter.log.info('Invalid answer from Vehicle request. Error: ' + err);
                            resolve({
                                error: true,
                                msg: 'Could not get any vehicle'
                            });
                            return;
                        }
                        Adapter.log.debug('vehicles Answer:' + JSON.stringify(vehicles));
                        resolve({
                            error: false,
                            msg: 'Success',
                            vehicles: vehicles
                        });
                    });
                });
            }
            Adapter.sendTo(msg.from, msg.command, {login: Response, vehicles: Vehicles}, msg.callback);
        }
    }

    async GetNewToken(){
        const Adapter = this;
        // No token, we try to get a token
        Adapter.log.info('Try to get a new token');
        await tjs.login(Adapter.config.teslaUsername, Adapter.config.teslaPassword, async (err, result) => {
            if(result.error || !result.authToken){
                Adapter.log.warn('Could not get token, Adapter cant read anything.');
            }
            else{
                await Adapter.SetNewToken(result.authToken, result.refreshToken, result.body.expires_in);
            }
        });
    }

    async RefreshToken(){
        const Adapter = this;

        let Expires = new Date(Adapter.config.tokenExpire);
        Expires.setDate(Expires.getDate() - 10); // Refresh 10 days before expire
        if(Expires < new Date()){
            tjs.refreshToken(Adapter.config.refreshToken, async (err, result) => {
                if(result.response.statusCode !== 200){
                    Adapter.log.warn('Could not refresh Token, trying to get a new Token');
                    await Adapter.setStateAsync('info.connection', false, true);
                    Adapter.GetNewToken();
                }
                else{
                    await Adapter.SetNewToken(result.authToken, result.refreshToken, result.body.expires_in);
                }
            })
        }
    }

    async SetNewToken(authToken, refreshToken, tokenExpire){
        const Adapter = this;
        Adapter.log.info('Setting a new Token, Adapter will reboot after this automatically');

        let ExpireDate = new Date();
        ExpireDate.setSeconds(ExpireDate.getSeconds() + tokenExpire);

        // Set new token to the settings, Adapter will reboot afterwards...
        let obj = await Adapter.getForeignObjectAsync(`system.adapter.${Adapter.namespace}`);

        if(!obj){
            Adapter.log.error('Could not get Adapter-Config');
            return;
        }
        obj.native.authToken = Adapter.config.authToken = authToken;
        obj.native.refreshToken = Adapter.config.refreshToken = refreshToken;
        obj.native.tokenExpire = Adapter.config.tokenExpire = ExpireDate.getTime();

        await Adapter.setForeignObjectAsync('system.adapter.tesla-motors.0', obj);

        await Adapter.setStateAsync('info.connection', true, true);
    }

    /**
     * Get all info that are available while car is sleeping
     * @constructor
     */
    async GetSleepingInfo(){
        const Adapter = this;
        const State = await Adapter.getStateAsync('info.connection');
        if(!State){
            Adapter.log.warn('You tried to get States, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        Adapter.log.debug("Getting Sleeping Info");

        // Vehicle need to get synchronized as we need the id later!
        await new Promise(async resolve => {
            let options = {authToken: Adapter.config.authToken};
            tjs.vehicle(options, (err, vehicle) => {
                if(err){
                    Adapter.log.error('Invalid answer from Vehicle request. Error: ' + err);
                    resolve();
                    return;
                }
                Adapter.log.debug('vehicle Answer:' + JSON.stringify(vehicle));

                Adapter.setStateCreate('vehicle.id_s', vehicle.id_s, 'string', false);
                Adapter.setStateCreate('vehicle.vin', vehicle.vin, 'string', false);
                Adapter.setStateCreate('vehicle.display_name', vehicle.display_name, 'string', false);
                Adapter.setStateCreate('command.awake', vehicle.state === 'online', 'boolean', true);
                if(Adapter.config.extendedData){
                    Adapter.setStateCreate('vehicle.option_codes', vehicle.option_codes, 'string', false);
                    Adapter.setStateCreate('vehicle.color', vehicle.color, 'string', false);
                }
                resolve();
            });
        })
    }

    async WakeItUp(){
        const Adapter = this;
        const State = await Adapter.getStateAsync('info.connection');
        if(!State){
            Adapter.log.warn('You tried to wake up the car, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        // Check if not yet awake
        await Adapter.GetSleepingInfo();
        let awakeState;
        awakeState = await Adapter.getStateAsync('command.awake').catch(() => {
        });
        if(awakeState && awakeState.val) return;

        await new Promise(async resolve => {
            Adapter.log.debug('Waking up the car...');
            let options = {
                authToken: Adapter.config.authToken,
                vehicleID: Adapter.config.vehicle_id_s
            };
            tjs.wakeUp(options, async (err, data) => {
                Adapter.WakeItUpRetryCount--;
                Adapter.log.debug("Wake up Response:" + JSON.stringify(data) + JSON.stringify(err));
                if(err || data.state !== "online"){
                    if(Adapter.WakeItUpRetryCount > 0){
                        Adapter.log.debug("Cant wake up the car, Retrying in 2 Seconds...");
                        await Sleep(2000);
                        await Adapter.WakeItUp();
                    }
                    else{
                        Adapter.log.warn("Was not able to wake up the car within 50 Seconds. Car has maybe not internet connection");
                        Adapter.WakeItUpRetryCount = 30;
                    }
                    resolve();
                }
                else{
                    Adapter.log.debug("Car is Awake");
                    Adapter.setState('command.awake', true, true);
                    Adapter.WakeItUpRetryCount = 30;
                    resolve();
                }
            });
        });
    }

    async GetAllInfo(){
        const Adapter = this;
        const State = await Adapter.getStateAsync('info.connection');
        if(!State || !State.val){
            Adapter.log.warn('You tried to wake up the car, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        await this.WakeItUp();
        Adapter.log.debug('Getting all States now');
        let options = {
            authToken: Adapter.config.authToken,
            vehicleID: Adapter.config.vehicle_id_s
        };
        let vd = await new Promise(async (resolve, reject) => {
            tjs.vehicleData(options, (err, data) => {
                Adapter.log.debug("Answer from vehicleState:" + JSON.stringify(data) + JSON.stringify(err));
                if(err){
                    reject(err);
                }
                else{
                    resolve(data);
                }
            });
        }).catch(error => {
            Adapter.log.warn('Could not retrieve Data from the Car! Response: ' + error);
        });

        Adapter.log.debug("Vehicle Data: " + JSON.stringify(vd));

        // km or miles?
        Adapter.distanceUnit = vd.gui_settings.gui_distance_units;

        // States with in and out
        Adapter.setStateCreate('command.doorLock', vd.vehicle_state.locked, 'boolean', false);
        Adapter.setState('command.awake', ('online' === vd.state), true);
        Adapter.setState('command.Climate', vd.climate_state.is_climate_on, true);
        Adapter.setState('command.SetTemperature', vd.climate_state.driver_temp_setting, true);
        Adapter.setState('command.SetChargeLimit', vd.charge_state.charge_limit_soc, true);
        Adapter.setState('command.ChargePort', vd.charge_state.charge_port_door_open, true);
        Adapter.setState('command.ValetMode', vd.vehicle_state.valet_mode, true);
        Adapter.setState('command.SpeedLimit', vd.vehicle_state.speed_limit_mode.active, true);
        Adapter.setState('command.SpeedLimitValue', Adapter.m_km(vd.vehicle_state.speed_limit_mode.current_limit_mph), true);
        Adapter.setState('command.SentryMode', vd.vehicle_state.sentry_mode, true);
        Adapter.setState('command.RemoteStart', vd.vehicle_state.remote_start, true);
        Adapter.setState('command.seat_heater_left', vd.climate_state.seat_heater_left, true);
        Adapter.setState('command.seat_heater_right', vd.climate_state.seat_heater_right, true);
        if(vd.vehicle_config.rear_seat_heaters === 1){
            Adapter.setStateCreate('command.seat_heater_rear_center', vd.climate_state.seat_heater_rear_center, 'number', true);
            Adapter.setStateCreate('command.seat_heater_rear_left', vd.climate_state.seat_heater_rear_left, 'number', true);
            Adapter.setStateCreate('command.seat_heater_rear_right', vd.climate_state.seat_heater_rear_right, 'number', true);
        }
        Adapter.setState('command.steering_wheel_heater', vd.climate_state.steering_wheel_heater, true);
        if(vd.vehicle_state.fd_window || vd.vehicle_state.fp_window || vd.vehicle_state.rd_window || vd.vehicle_state.rp_window){
            Adapter.setState('command.windowVent', true, true);
        }
        else{
            Adapter.setState('command.windowVent', false, true);
        }

        // all other states
        Adapter.setStateCreate('chargeState.charging_state', vd.charge_state.charging_state, 'string', false);
        Adapter.setStateCreate('chargeState.battery_level', vd.charge_state.battery_level, 'number', false);
        Adapter.setStateCreate('chargeState.battery_range', Adapter.m_km(vd.charge_state.battery_range), 'number', false);
        Adapter.setStateCreate('chargeState.est_battery_range', Adapter.m_km(vd.charge_state.est_battery_range), 'number', false);
        Adapter.setStateCreate('chargeState.ideal_battery_range', Adapter.m_km(vd.charge_state.ideal_battery_range), 'number', false);
        Adapter.setStateCreate('chargeState.scheduled_charging_start_time', vd.charge_state.scheduled_charging_start_time, 'string', false);
        Adapter.setStateCreate('chargeState.battery_heater_on', vd.charge_state.battery_heater_on, 'boolean', false);
        Adapter.setStateCreate('chargeState.minutes_to_full_charge', vd.charge_state.minutes_to_full_charge, 'number', false);

        if(Adapter.config.extendedData){
            Adapter.setStateCreate('chargeState.fast_charger_present', vd.charge_state.fast_charger_present, 'boolean', false);
            Adapter.setStateCreate('chargeState.usable_battery_level', vd.charge_state.usable_battery_level, 'number', false);
            Adapter.setStateCreate('chargeState.charge_energy_added', vd.charge_state.charge_energy_added, 'number', false);
            Adapter.setStateCreate('chargeState.charge_distance_added_rated', Adapter.m_km(vd.charge_state.charge_miles_added_rated), 'number', false);
            Adapter.setStateCreate('chargeState.charger_voltage', vd.charge_state.charger_voltage, 'number', false);
            Adapter.setStateCreate('chargeState.charger_power', vd.charge_state.charger_power, 'number', false);
            Adapter.setStateCreate('chargeState.charge_current_request', vd.charge_state.charge_current_request, 'number', false);
            Adapter.setStateCreate('chargeState.charge_port_cold_weather_mode', vd.charge_state.charge_port_cold_weather_mode, 'boolean', false);
        }

        Adapter.setStateCreate('climateState.inside_temp', vd.climate_state.inside_temp, 'number', false);
        Adapter.setStateCreate('climateState.outside_temp', vd.climate_state.outside_temp, 'number', false);
        Adapter.setStateCreate('climateState.max_avail_temp', vd.climate_state.max_avail_temp, 'number', false);
        Adapter.setStateCreate('climateState.min_avail_temp', vd.climate_state.min_avail_temp, 'number', false);
        Adapter.setStateCreate('climateState.run_roof_installed', vd.vehicle_config.sun_roof_installed, 'number', false);
        if(vd.vehicle_config.sun_roof_installed){
            Adapter.setStateCreate('climateState.sun_roof_percent_open', vd.climate_state.sun_roof_percent_open, 'number', true);
            Adapter.setStateCreate('command.SunRoofVent', 'vent' === vd.climate_state.sun_roof_state, 'boolean', false);
        }
        if(Adapter.config.extendedData){
            Adapter.setStateCreate('climateState.wiper_blade_heater', vd.climate_state.wiper_blade_heater, 'boolean', false);
            Adapter.setStateCreate('climateState.side_mirror_heaters', vd.climate_state.side_mirror_heaters, 'boolean', false);
            Adapter.setStateCreate('climateState.is_preconditioning', vd.climate_state.is_preconditioning, 'boolean', false);
            Adapter.setStateCreate('climateState.smart_preconditioning', vd.climate_state.smart_preconditioning, 'boolean', false);
            Adapter.setStateCreate('climateState.is_auto_conditioning_on', vd.climate_state.is_auto_conditioning_on, 'boolean', false);
            Adapter.setStateCreate('climateState.battery_heater', vd.climate_state.battery_heater, 'boolean', false);
        }


        Adapter.setStateCreate('driveState.shift_state', vd.drive_state.shift_state, 'string', false);
        Adapter.setStateCreate('driveState.speed', Adapter.m_km(vd.drive_state.speed), 'number', false);
        Adapter.setStateCreate('driveState.power', vd.drive_state.power, 'number', false);
        Adapter.setStateCreate('driveState.latitude', vd.drive_state.latitude, 'number', false);
        Adapter.setStateCreate('driveState.longitude', vd.drive_state.longitude, 'number', false);
        Adapter.setStateCreate('driveState.heading', vd.drive_state.heading, 'number', false);
        Adapter.setStateCreate('driveState.gps_as_of', vd.drive_state.gps_as_of, 'number', false);
        Adapter.setStateCreate('driveState.SpeedLimitMax', Adapter.m_km(vd.vehicle_state.speed_limit_mode.max_limit_mph), 'number', false);
        Adapter.setStateCreate('driveState.SpeedLimitMin', Adapter.m_km(vd.vehicle_state.speed_limit_mode.min_limit_mph), 'number', false);


        Adapter.setStateCreate('vehicle.is_user_present', vd.vehicle_state.is_user_present, 'boolean', false);
        Adapter.setStateCreate('vehicle.odometer', vd.vehicle_state.odometer, 'number', false);
        Adapter.setStateCreate('vehicle.front_driver_window', vd.vehicle_state.fd_window, 'boolean', false);
        Adapter.setStateCreate('vehicle.front_passenger_window', vd.vehicle_state.fp_window, 'boolean', false);
        Adapter.setStateCreate('vehicle.rear_driver_window', vd.vehicle_state.rd_window, 'boolean', false);
        Adapter.setStateCreate('vehicle.rear_passenger_window', vd.vehicle_state.rp_window, 'boolean', false);
        Adapter.setStateCreate('vehicle.car_type', vd.vehicle_config.car_type, 'boolean', false);

        Adapter.setStateCreate('softwareUpdate.download_percentage', vd.vehicle_state.software_update.download_perc, 'number', false);
        Adapter.setStateCreate('softwareUpdate.expected_duration_sec', vd.vehicle_state.software_update.expected_duration_sec, 'number', false);
        Adapter.setStateCreate('softwareUpdate.install_percentage', vd.vehicle_state.software_update.install_perc, 'number', false);
        Adapter.setStateCreate('softwareUpdate.status', vd.vehicle_state.software_update.status, 'string', false);
        Adapter.setStateCreate('softwareUpdate.version', vd.vehicle_state.software_update.version, 'string', false);
    }

    m_km(value){
        if(this.distanceUnit === 'mi/hr') return value;
        else return Math.round(value * 1.60934);
    }

    km_m(value){
        if(this.distanceUnit === 'mi/hr') return value;
        else return Math.round(value / 1.60934);
    }

    initCommandObjects(){
        this.setStateCreate('command.awake', false, 'boolean', true, true);
        this.setStateCreate('command.doorLock', true);
        this.setStateCreate('command.honkHorn', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.flashLights', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.Climate', false, 'boolean');
        this.setStateCreate('command.SetTemperature', 21, 'number');
        this.setStateCreate('command.SetChargeLimit', 80, 'number');
        this.setStateCreate('command.ChargePort', false, 'boolean');
        this.setStateCreate('command.Charging', false, 'boolean');
        this.setStateCreate('command.ValetMode', false, 'boolean');
        this.setStateCreate('command.ValetPin', '????');
        this.setStateCreate('command.SpeedLimit', false, 'boolean');
        this.setStateCreate('command.SpeedLimitValue', false, 'number');
        this.setStateCreate('command.SentryMode', false, 'boolean');
        this.setStateCreate('command.RemoteStart', false, 'boolean');
        this.setStateCreate('command.StartSoftwareUpdate', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.seat_heater_left', 0, 'number', true);
        this.setStateCreate('command.seat_heater_right', 0, 'number', true);
        this.setStateCreate('command.steering_wheel_heater', false, 'boolean', true);
        this.setStateCreate('command.windowVent', false, 'boolean', true);
        this.setStateCreate('command.openTrunk', false, 'boolean', true);
        this.setStateCreate('command.openFrunk', false, 'boolean', true);
    }

    /**
     * type "number" | "string" | "boolean" | "array" | "object" | "mixed" | "file"
     */
    setStateCreate(id, state, type = 'string', write = true, read = true, role = ''){
        this.setObjectNotExists(id, {
            type: 'state',
            common: {name: id.substring(id.lastIndexOf('.') + 1), type: type, role: role, read: read, write: write},
            native: []
        });
        this.setState(id, state, true);
    }


}

// @ts-ignore parent is a valid property on module
if(module.parent){
    // Export the constructor in compact mode
    module.exports = (options) => new TeslaMotors(options);
}
else{
    // otherwise start the instance directly
    new TeslaMotors();
}

function Sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}