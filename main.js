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
        this.lastTimeWokeUp = new Date();
        this.lastWakeState = false;
        this.refreshData = false;
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
            await Adapter.setStateAsync('info.connection', false, true);
        }
        else if(Expires < new Date()){
            await this.RefreshToken();
        }
        else{
            await Adapter.setStateAsync('info.connection', true, true);
            Adapter.log.debug("Connected to Tesla");
        }

        Adapter.log.debug("Everything initialized, setting up wakeUp strategy");
        Adapter.SetupWakeupStrategy();
        Adapter.refreshData = true;
    }

    async SetupWakeupStrategy(){
        const Adapter = this;
        // Check for Token Refresh once per day but sure on startup
        await Adapter.RefreshToken();
        setInterval(() => {
            if(Adapter.config.authToken.length === 0) return;
            Adapter.RefreshToken();
        }, 24 * 60 * 60 * 1000);
        // Get sleeping info once per minute
        await Adapter.GetSleepingInfo();
        setInterval(() => {
            Adapter.GetSleepingInfo();
        }, 60 * 1000);

        // Setting up Interval based on wakeup-Plan
        switch(Adapter.config.wakeupPlan){
            case 'aggressive':
                setInterval(() => {
                    Adapter.GetAllInfo();
                }, 60 * 1000); // Once per Minute
                break;
            case 'temperate':
                setInterval(() => {
                    Adapter.GetAllInfo();
                }, 60 * 60 * 1000); // Once per Hour
                break;
            case 'off':
                // Only get data when something changes or car is awake anyway (Done in GetSleepingInfo)
                break;
            case 'smart':
            default:
                /* Theory:
                 * When car wakes up, there is someting happening.
                 * So if car woke up, get data every minute for 10 minutes.
                 * If nothing happend (Car start, Climate start, Charging) leave car alone to let him fall asleep.
                 * If not went to sleep, request data and wait again 15 minutes.
                 * But: If last wake up is more than 12 hours ago, request state!
                 *
                 * The whole thing is 1-minute-timer-based, so we do this stuff every minute
                 */
                setInterval(async () => {
                    let Minutes = Math.floor((new Date().getTime() - this.lastTimeWokeUp.getTime() / 60000));
                    // if car is in use, set lastTimeWokeUp to 0
                    let shift_state = await Adapter.getStateAsync('driveState.shift_state');
                    let speed = await Adapter.getStateAsync('driveState.speed');
                    let climate = await Adapter.getStateAsync('command.Climate');
                    let chargeState = await Adapter.getStateAsync('chargeState.charging_state');

                    if((shift_state && shift_state.val !== null && shift_state.val !== "P") ||
                        (speed && speed.val > 0) ||
                        (climate && climate.val) ||
                        (chargeState && chargeState.val !== 'Disconnected' && chargeState.val !== 'Complete')){
                        this.lastTimeWokeUp = new Date();
                    }
                    if(Minutes <= 10){
                        await Adapter.GetAllInfo();
                    }
                    else if(Minutes > 10 && Minutes <= 25){
                        // Dont do anything, try to let the car sleep...
                    }
                    else if(Minutes > 25){
                        // Check if car is still awake. If so, request once and then go back to "let it sleep"
                        let awakeState = await Adapter.getStateAsync('command.awake');
                        if(awakeState && awakeState.val && awakeState.ack){
                            await Adapter.GetAllInfo();
                            this.lastTimeWokeUp = new Date();
                            this.lastTimeWokeUp.setMinutes(new Date().getMinutes() - 11);
                        }
                    }
                    else if(Minutes > 60*12){
                        await Adapter.GetAllInfo();
                    }
                }, 60 * 1000);
                break;
        }

        setInterval(async () => {
            if(Adapter.refreshData){
                Adapter.refreshData = false;
                await Adapter.GetAllInfo();
            }
        },1000); // Check if we are asked for a refresh
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
                        Adapter.setStateCreate('command.ValetPin','PIN for Valet Mode', '????');
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
                    Adapter.setState('command.openTrunk', false, true);
                    requestDataChange = false;
                    break;
                case 'command.openFrunk':
                    await tjs.openTrunkAsync(options, 'rear');
                    Adapter.setState('command.openFrunk', false, true);
                    requestDataChange = false;
                    break;
                default:
                    requestDataChange = false;
                    break;
            }
            if(requestDataChange){
                Adapter.refreshData = true;
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

        await new Promise(async resolve => {
            let vehicleIndex = 0;
            Adapter.config.vehicles.forEach(function(vehicle,idx) {
                if(vehicle["id_s"] === Adapter.config.vehicle_id_s){
                    vehicleIndex = idx;
                }
            });
            let options = {
                authToken: Adapter.config.authToken,
                carIndex: vehicleIndex};

            let vehicle = await tjs.vehicleAsync(options).catch(err => {
                Adapter.log.error('Invalid answer from Vehicle request. Error: ' + err);
                resolve();
            });
            Adapter.log.debug('vehicle Answer:' + JSON.stringify(vehicle));

            Adapter.setStateCreate('vehicle.id_s', 'API Identifier of the car', vehicle.id_s, 'string', false);
            Adapter.setStateCreate('vehicle.vin', 'VIN',vehicle.vin, 'string', false);
            Adapter.setStateCreate('vehicle.display_name', 'Your car name', vehicle.display_name, 'string', false);
            Adapter.setStateCreate('command.awake', 'Sleep State', vehicle.state === 'online', 'boolean', true);
            if(Adapter.config.extendedData){
                Adapter.setStateCreate('vehicle.option_codes','Option Codes', vehicle.option_codes, 'string', false);
                Adapter.setStateCreate('vehicle.color', 'Your car Color', vehicle.color, 'string', false);
            }

            if(vehicle.state === 'online' && !this.lastWakeState){
                // Car was sleeping before, but woke up now. So we trigger a refresh of data
                this.refreshData = true;
                this.lastTimeWokeUp = new Date();
            }
            this.lastWakeState = vehicle.state === 'online';
            resolve();
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
        awakeState = await Adapter.getStateAsync('command.awake');
        if(awakeState && awakeState.val && awakeState.ack) return;

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
        Adapter.setStateCreate('command.doorLock','Lock / Open the door', vd.vehicle_state.locked, 'boolean', false);
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
            Adapter.setStateCreate('command.seat_heater_rear_center','Rear center seat heater (0-3)', vd.climate_state.seat_heater_rear_center, 'number', true);
            Adapter.setStateCreate('command.seat_heater_rear_left','Rear left seat heater (0-3)', vd.climate_state.seat_heater_rear_left, 'number', true);
            Adapter.setStateCreate('command.seat_heater_rear_right','Rear right seat heater (0-3)', vd.climate_state.seat_heater_rear_right, 'number', true);
        }
        Adapter.setState('command.steering_wheel_heater', vd.climate_state.steering_wheel_heater, true);
        if(vd.vehicle_state.fd_window || vd.vehicle_state.fp_window || vd.vehicle_state.rd_window || vd.vehicle_state.rp_window){
            Adapter.setState('command.windowVent', true, true);
        }
        else{
            Adapter.setState('command.windowVent', false, true);
        }

        // all other states
        Adapter.setStateCreate('chargeState.charging_state','Charging State', vd.charge_state.charging_state, 'string', false);
        Adapter.setStateCreate('chargeState.battery_level','Battery level in %', vd.charge_state.battery_level, 'number', false, true, '', '%');
        Adapter.setStateCreate('chargeState.battery_range','Battery Range', Adapter.m_km(vd.charge_state.battery_range), 'number', false, true, '', Adapter.distanceUnit);
        Adapter.setStateCreate('chargeState.est_battery_range','Estimated Battery Range', Adapter.m_km(vd.charge_state.est_battery_range), 'number', false, true, '', Adapter.distanceUnit);
        Adapter.setStateCreate('chargeState.ideal_battery_range','Ideal Battery Range', Adapter.m_km(vd.charge_state.ideal_battery_range), 'number', false, true, '', Adapter.distanceUnit);
        Adapter.setStateCreate('chargeState.scheduled_charging_start_time','Scheduled charge start Time', vd.charge_state.scheduled_charging_start_time, 'string', false);
        Adapter.setStateCreate('chargeState.battery_heater_on','Battery Heater State', vd.charge_state.battery_heater_on, 'boolean', false);
        Adapter.setStateCreate('chargeState.minutes_to_full_charge','Minutes to fully Charge', vd.charge_state.minutes_to_full_charge, 'number', false);

        if(Adapter.config.extendedData){
            Adapter.setStateCreate('chargeState.fast_charger_present','Fast Charger connected', vd.charge_state.fast_charger_present, 'boolean', false);
            Adapter.setStateCreate('chargeState.usable_battery_level','Usable battery level', vd.charge_state.usable_battery_level, 'number', false, true, '', '%');
            Adapter.setStateCreate('chargeState.charge_energy_added','Energy added with Charge', vd.charge_state.charge_energy_added, 'number', false, true, '', 'kW');
            Adapter.setStateCreate('chargeState.charge_distance_added_rated','Distance added with Charge', Adapter.m_km(vd.charge_state.charge_miles_added_rated), 'number', false, true, '', Adapter.distanceUnit);
            Adapter.setStateCreate('chargeState.charger_voltage','Charger Voltage', vd.charge_state.charger_voltage, 'number', false, true, '', 'V');
            Adapter.setStateCreate('chargeState.charger_power','Charger Power', vd.charge_state.charger_power, 'number', false, true, '', 'W');
            Adapter.setStateCreate('chargeState.charge_current_request','Charge current requested', vd.charge_state.charge_current_request, 'number', false, true, '', 'A');
            Adapter.setStateCreate('chargeState.charge_port_cold_weather_mode','Charge port cold weather mode', vd.charge_state.charge_port_cold_weather_mode, 'boolean', false);
        }

        Adapter.setStateCreate('climateState.inside_temp','Inside Temperature', vd.climate_state.inside_temp, 'number', false, true, '', 'C°');
        Adapter.setStateCreate('climateState.outside_temp','Ouside Temperature', vd.climate_state.outside_temp, 'number', false, true, '', 'C°');
        Adapter.setStateCreate('climateState.max_avail_temp','Max. available inside Temperature', vd.climate_state.max_avail_temp, 'number', false, true, '', 'C°');
        Adapter.setStateCreate('climateState.min_avail_temp','Min. available inside Temperature', vd.climate_state.min_avail_temp, 'number', false, true, '', 'C°');
        Adapter.setStateCreate('climateState.sun_roof_installed','Sun Roof Installed', vd.vehicle_config.sun_roof_installed, 'number', false);
        if(vd.vehicle_config.sun_roof_installed){
            Adapter.setStateCreate('climateState.sun_roof_percent_open','Sun Roof % open', vd.climate_state.sun_roof_percent_open, 'number', true, true, '', '%');
            Adapter.setStateCreate('command.SunRoofVent','Sun Roof Vent', 'vent' === vd.climate_state.sun_roof_state, 'boolean', false);
        }
        Adapter.setStateCreate('climateState.front_driver_window','Front driver window state', vd.vehicle_state.fd_window, 'boolean', false);
        Adapter.setStateCreate('climateState.front_passenger_window','Front passenger window state', vd.vehicle_state.fp_window, 'boolean', false);
        Adapter.setStateCreate('climateState.rear_driver_window','Rear driver window state', vd.vehicle_state.rd_window, 'boolean', false);
        Adapter.setStateCreate('climateState.rear_passenger_window','Front Passenger window state', vd.vehicle_state.rp_window, 'boolean', false);

        if(Adapter.config.extendedData){
            Adapter.setStateCreate('climateState.wiper_blade_heater','Wiper blade heater', vd.climate_state.wiper_blade_heater, 'boolean', false);
            Adapter.setStateCreate('climateState.side_mirror_heaters','Side mirrors heaters', vd.climate_state.side_mirror_heaters, 'boolean', false);
            Adapter.setStateCreate('climateState.is_preconditioning','Is preconditioning', vd.climate_state.is_preconditioning, 'boolean', false);
            Adapter.setStateCreate('climateState.smart_preconditioning','Smart preconditioning', vd.climate_state.smart_preconditioning, 'boolean', false);
            Adapter.setStateCreate('climateState.is_auto_conditioning_on','Auto conditioning', vd.climate_state.is_auto_conditioning_on, 'boolean', false);
            Adapter.setStateCreate('climateState.battery_heater','Battery heater', vd.climate_state.battery_heater, 'boolean', false);
        }


        Adapter.setStateCreate('driveState.shift_state','Shift State', vd.drive_state.shift_state, 'string', false);
        Adapter.setStateCreate('driveState.speed','Speed', Adapter.m_km(vd.drive_state.speed), 'number', false, true, '', Adapter.distanceUnit);
        Adapter.setStateCreate('driveState.power','Power', vd.drive_state.power, 'number', false);
        Adapter.setStateCreate('driveState.latitude','Current position latitude', vd.drive_state.latitude, 'number', false);
        Adapter.setStateCreate('driveState.longitude','Current position longitude', vd.drive_state.longitude, 'number', false);
        Adapter.setStateCreate('driveState.heading','Car heading', vd.drive_state.heading, 'number', false, true, '', '°deg');
        Adapter.setStateCreate('driveState.gps_as_of','Timestamp of last gps position', vd.drive_state.gps_as_of, 'number', false);
        Adapter.setStateCreate('driveState.SpeedLimitMax','Speed limit Max settable', Adapter.m_km(vd.vehicle_state.speed_limit_mode.max_limit_mph), 'number', false, true, '', Adapter.distanceUnit);
        Adapter.setStateCreate('driveState.SpeedLimitMin','Speed limit Min settable', Adapter.m_km(vd.vehicle_state.speed_limit_mode.min_limit_mph), 'number', false, true, '', Adapter.distanceUnit);


        Adapter.setStateCreate('vehicle.is_user_present','Is user present', vd.vehicle_state.is_user_present, 'boolean', false);
        Adapter.setStateCreate('vehicle.odometer','Odometer', vd.vehicle_state.odometer, 'number', false);
        Adapter.setStateCreate('vehicle.car_type','Car Type', vd.vehicle_config.car_type, 'boolean', false);

        Adapter.setStateCreate('softwareUpdate.download_percentage','Software download in %', vd.vehicle_state.software_update.download_perc, 'number', false, true, '', '%');
        Adapter.setStateCreate('softwareUpdate.expected_duration_sec','Update duration expected', vd.vehicle_state.software_update.expected_duration_sec, 'number', false, true, '', 's');
        Adapter.setStateCreate('softwareUpdate.install_percentage','Installation in %', vd.vehicle_state.software_update.install_perc, 'number', false, true, '', '%');
        Adapter.setStateCreate('softwareUpdate.status','Update Status', vd.vehicle_state.software_update.status, 'string', false);
        Adapter.setStateCreate('softwareUpdate.version','Update Version', vd.vehicle_state.software_update.version, 'string', false);
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
        this.setStateCreate('command.awake','Wake up State', false, 'boolean', true, true);
        this.setStateCreate('command.doorLock','Door Lock', true);
        this.setStateCreate('command.honkHorn','Honk the horn', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.flashLights','Flash the lights', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.Climate','Climate State', false, 'boolean');
        this.setStateCreate('command.SetTemperature','Set Temperature', 21, 'number', true, true, '','C°');
        this.setStateCreate('command.SetChargeLimit','Set charge Limit', 80, 'number', true, true, '','%');
        this.setStateCreate('command.ChargePort','Open / Close charge Port', false, 'boolean');
        this.setStateCreate('command.Charging','Start / Stop Charging', false, 'boolean');
        this.setStateCreate('command.ValetMode','Valet Mode', false, 'boolean');
        this.setStateCreate('command.ValetPin','Valet Pin', '????');
        this.setStateCreate('command.SpeedLimit','Activate Speed Limit', false, 'boolean');
        this.setStateCreate('command.SpeedLimitValue','Speed Limit value', false, 'number', true, true, '',this.distanceUnit);
        this.setStateCreate('command.SentryMode','Activate sentry mode', false, 'boolean');
        this.setStateCreate('command.RemoteStart','Activate remote start', false, 'boolean');
        this.setStateCreate('command.StartSoftwareUpdate','Start Software Update', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.seat_heater_left','Seat Heater Left', 0, 'number', true);
        this.setStateCreate('command.seat_heater_right','Seat Heater Right', 0, 'number', true);
        this.setStateCreate('command.steering_wheel_heater','Steering wheel heater', false, 'boolean', true);
        this.setStateCreate('command.windowVent','Window Vent', false, 'boolean', true);
        this.setStateCreate('command.openTrunk','Open Trunk', false, 'boolean', true, true, 'button');
        this.setStateCreate('command.openFrunk','Open Frunk', false, 'boolean', true, true, 'button');
    }

    /**
     * type "number" | "string" | "boolean" | "array" | "object" | "mixed" | "file"
     */
    setStateCreate(id, name, state, type = 'string', write = true, read = true, role = '', unit = ''){
        this.setObjectNotExists(id, {
            type: 'state',
            common: {name: name, type: type, role: role, unit: unit, read: read, write: write},
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