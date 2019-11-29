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
        this.distanceUnit = '';
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

        await Adapter.installObjects();
        this.subscribeStates('command.*');
        this.log.debug('Starting Tesla Motors');
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
                    let Minutes = Math.floor((new Date().getTime() - this.lastTimeWokeUp.getTime()) / 60000);
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
                        let standby = await Adapter.getStateAsync('command.standby');
                        if(standby && !standby.val && standby.ack){
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
                case 'command.standby':
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
                case 'command.UnlockChargePort':
                    const ChargePort = await Adapter.getStateAsync('command.ChargePort');
                    if(ChargePort){
                        await tjs.openChargePortAsync(options);
                    }
                    Adapter.setState('command.UnlockChargePort', false, true);
                    requestDataChange = false;
                    break;
                case 'command.Charging':
                    if(state.val){
                        let charge = await tjs.startChargeAsync(options).catch((err)=>{
                            Adapter.log.error('Err:'+err);
                        });
                        if(charge.result === false){
                            Adapter.setState('command.Charging', false, true);
                        }
                        else {
                            Adapter.setState('command.Charging', true, true);
                        }
                    }
                    else{
                        await tjs.stopChargeAsync(options);
                        Adapter.setState('command.Charging', false, true);
                    }
                    break;
                case 'command.ValetMode':
                    const ValetPin = await Adapter.getStateAsync('command.ValetPin');
                    if(!ValetPin){
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
            let password = decrypt('rEYbFGzsXW8QBx5', msg.message.teslaPassword);
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
        await tjs.login(Adapter.config.teslaUsername, decrypt('rEYbFGzsXW8QBx5', Adapter.config.teslaPassword), async (err, result) => {
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

            Adapter.setState('vehicle.id_s', vehicle.id_s, true);
            Adapter.setState('vehicle.vin', vehicle.vin, true);
            Adapter.setState('vehicle.display_name', vehicle.display_name, true);
            Adapter.setState('command.standby', 'online' !== vehicle.state, true);
            Adapter.setState('vehicle.option_codes', vehicle.option_codes, true);
            Adapter.setState('vehicle.color', vehicle.color, true);

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
        // Check if in standby
        await Adapter.GetSleepingInfo();
        let standby;
        standby = await Adapter.getStateAsync('command.standby');
        if(standby && !standby.val && standby.ack) return;

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
                    Adapter.setState('command.standby', false, true);
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
        let OldDistanceUnit = Adapter.distanceUnit;
        Adapter.distanceUnit = vd.gui_settings.gui_distance_units === 'mi/hr' ? 'mi/hr' : 'km/h';

        if(OldDistanceUnit !== Adapter.distanceUnit){
            await Adapter.installDistanceObjects();
        }
        // States with in and out
        Adapter.setState('command.doorLock', !vd.vehicle_state.locked, true);
        Adapter.setState('command.standby', ('online' !== vd.state), true);
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
        Adapter.setState('command.steering_wheel_heater', vd.climate_state.steering_wheel_heater, true);
        if(vd.vehicle_state.fd_window || vd.vehicle_state.fp_window || vd.vehicle_state.rd_window || vd.vehicle_state.rp_window){
            Adapter.setState('command.windowVent', true, true);
        }
        else{
            Adapter.setState('command.windowVent', false, true);
        }

        // all other states
        Adapter.setState('chargeState.charging_state', vd.charge_state.charging_state, true);
        if(vd.charge_state.charging_state === 'Charging'){
            Adapter.setState('command.Charging', true, true);
        }
        else if(vd.charge_state.charging_state === 'Disconnected' || vd.charge_state.charging_state === 'Stopped') {
            Adapter.setState('command.Charging', false, true);
        }
        Adapter.setState('chargeState.battery_level', vd.charge_state.battery_level, true);
        Adapter.setState('chargeState.battery_range', Adapter.m_km(vd.charge_state.battery_range), true);
        Adapter.setState('chargeState.est_battery_range', Adapter.m_km(vd.charge_state.est_battery_range), true);
        Adapter.setState('chargeState.ideal_battery_range', Adapter.m_km(vd.charge_state.ideal_battery_range), true);
        Adapter.setState('chargeState.scheduled_charging_start_time', vd.charge_state.scheduled_charging_start_time, true);
        Adapter.setState('chargeState.battery_heater_on', vd.charge_state.battery_heater_on, true);
        Adapter.setState('chargeState.minutes_to_full_charge', vd.charge_state.minutes_to_full_charge, true);
        Adapter.setState('chargeState.fast_charger_present', vd.charge_state.fast_charger_present, true);
        Adapter.setState('chargeState.usable_battery_level', vd.charge_state.usable_battery_level, true);
        Adapter.setState('chargeState.charge_energy_added', vd.charge_state.charge_energy_added, true);
        Adapter.setState('chargeState.charge_distance_added_rated', Adapter.m_km(vd.charge_state.charge_miles_added_rated), true);
        Adapter.setState('chargeState.charger_voltage', vd.charge_state.charger_voltage, true);
        Adapter.setState('chargeState.charger_power', vd.charge_state.charger_power, true);
        Adapter.setState('chargeState.charge_current_request', vd.charge_state.charge_current_request, true);
        Adapter.setState('chargeState.charge_port_cold_weather_mode', vd.charge_state.charge_port_cold_weather_mode, true);

        Adapter.setState('climateState.inside_temp', vd.climate_state.inside_temp, true);
        Adapter.setState('climateState.outside_temp', vd.climate_state.outside_temp, true);
        Adapter.setState('climateState.max_avail_temp', vd.climate_state.max_avail_temp, true);
        Adapter.setState('climateState.min_avail_temp', vd.climate_state.min_avail_temp, true);

        Adapter.setState('climateState.sun_roof_installed', vd.vehicle_config.sun_roof_installed, true);

        Adapter.setState('climateState.front_driver_window', vd.vehicle_state.fd_window, true);
        Adapter.setState('climateState.front_passenger_window', vd.vehicle_state.fp_window, true);
        Adapter.setState('climateState.rear_driver_window', vd.vehicle_state.rd_window, true);
        Adapter.setState('climateState.rear_passenger_window', vd.vehicle_state.rp_window, true);

        Adapter.setState('climateState.wiper_blade_heater', vd.climate_state.wiper_blade_heater, true);
        Adapter.setState('climateState.side_mirror_heaters', vd.climate_state.side_mirror_heaters, true);
        Adapter.setState('climateState.is_preconditioning', vd.climate_state.is_preconditioning, true);
        Adapter.setState('climateState.smart_preconditioning', vd.climate_state.smart_preconditioning, true);
        Adapter.setState('climateState.is_auto_conditioning_on', vd.climate_state.is_auto_conditioning_on, true);
        Adapter.setState('climateState.battery_heater', vd.climate_state.battery_heater, true);

        Adapter.setState('driveState.shift_state', vd.drive_state.shift_state, true);
        Adapter.setState('driveState.speed', Adapter.m_km(vd.drive_state.speed), true);
        Adapter.setState('driveState.power', vd.drive_state.power, true);
        Adapter.setState('driveState.latitude', vd.drive_state.latitude, true);
        Adapter.setState('driveState.longitude', vd.drive_state.longitude, true);
        Adapter.setState('driveState.heading', vd.drive_state.heading, true);
        Adapter.setState('driveState.gps_as_of', vd.drive_state.gps_as_of, true);


        Adapter.setState('vehicle.is_user_present', vd.vehicle_state.is_user_present, true);
        Adapter.setState('vehicle.odometer', vd.vehicle_state.odometer, true);
        Adapter.setState('vehicle.car_type', vd.vehicle_config.car_type, true);

        Adapter.setState('softwareUpdate.download_percentage', vd.vehicle_state.software_update.download_perc, true);
        Adapter.setState('softwareUpdate.expected_duration_sec', vd.vehicle_state.software_update.expected_duration_sec, true);
        Adapter.setState('softwareUpdate.install_percentage', vd.vehicle_state.software_update.install_perc, true);
        Adapter.setState('softwareUpdate.status', vd.vehicle_state.software_update.status, true);
        Adapter.setState('softwareUpdate.version', vd.vehicle_state.software_update.version, true);

        if(!await Adapter.getStateAsync('command.SetTemperature')){
            await Adapter.installDependantObjects(vd);
        }

        // Late dependant
        if(vd.vehicle_config.sun_roof_installed){
            Adapter.setState('climateState.sun_roof_percent_open', vd.climate_state.sun_roof_percent_open, true);
            Adapter.setState('command.SunRoofVent', 'vent' === vd.climate_state.sun_roof_state, true);
        }

        if(vd.vehicle_config.rear_seat_heaters === 1){
            Adapter.setState('command.seat_heater_rear_center', vd.climate_state.seat_heater_rear_center, true);
            Adapter.setState('command.seat_heater_rear_left', vd.climate_state.seat_heater_rear_left, true);
            Adapter.setState('command.seat_heater_rear_right', vd.climate_state.seat_heater_rear_right, true);
        }


        let SpeedLimitMax = await Adapter.getStateAsync('driveState.SpeedLimitMax');
        let SpeedLimitMin = await Adapter.getStateAsync('driveState.SpeedLimitMin');

        Adapter.setState('driveState.SpeedLimitMax', Adapter.m_km(vd.vehicle_state.speed_limit_mode.max_limit_mph), true);
        Adapter.setState('driveState.SpeedLimitMin', Adapter.m_km(vd.vehicle_state.speed_limit_mode.min_limit_mph), true);

        if(!SpeedLimitMax
            || !SpeedLimitMin
            || SpeedLimitMax.val !== Adapter.m_km(vd.vehicle_state.speed_limit_mode.max_limit_mph)
            || SpeedLimitMin.val !== Adapter.m_km(vd.vehicle_state.speed_limit_mode.min_limit_mph)
            || OldDistanceUnit !== Adapter.distanceUnit
        ){
            let spmax = Adapter.m_km(vd.vehicle_state.speed_limit_mode.max_limit_mph);
            let spmin = Adapter.m_km(vd.vehicle_state.speed_limit_mode.min_limit_mph);

            await Adapter.setObjectAsync('command.SpeedLimitValue', {
                type: 'state',
                common: {
                    name: 'Limit car Speed',
                    desc: 'Min ' + spmin + Adapter.distanceUnit + ', Max ' + spmax + Adapter.distanceUnit,
                    type: 'number',
                    role: 'value.speed',
                    unit: Adapter.distanceUnit,
                    read: true,
                    write: true,
                    min: spmin,
                    max: spmax
                },
                native: []
            });
        }
    }

    m_km(value){
        if(this.distanceUnit === 'mi/hr') return value;
        else return Math.round(value * 1.60934);
    }

    km_m(value){
        if(this.distanceUnit === 'mi/hr') return value;
        else return Math.round(value / 1.60934);
    }

    async installObjects(){
        let SleepStates = [ // States that can be retrieved while car is sleeping
            // commands
            {
                id: 'command.standby',
                name: 'Wake up State',
                type: 'boolean',
                role: 'info.standby',
                read: true,
                write: true
            },

            // states read only
            {
                id: 'vehicle.id_s',
                name: 'API Identifier of the car',
                type: 'string',
                role: 'info.address',
                read: true,
                write: false
            },
            {id: 'vehicle.vin', name: 'VIN', type: 'string', role: 'info.address', read: true, write: false},
            {
                id: 'vehicle.display_name',
                name: 'Your car name',
                type: 'string',
                role: 'info.name',
                read: true,
                write: false
            },
            {
                id: 'vehicle.option_codes',
                name: 'List of option codes of your car',
                desc: 'Check them on https://tesla-api.timdorr.com/vehicle/optioncodes',
                type: 'string',
                role: 'text',
                read: true,
                write: false
            },
            {id: 'vehicle.color', name: 'Color of your car', type: 'string', role: 'text', read: true, write: false},
        ];
        let AwakeStates = [ // States that need to wake up the car to be read
            // commands
            {
                id: 'command.doorLock',
                name: 'Door Lock',
                desc: 'true - open, false - close',
                type: 'boolean',
                role: 'switch.lock.door',
                read: true,
                write: true
            },
            {
                id: 'command.honkHorn',
                name: 'Honk Horn',
                type: 'boolean',
                role: 'button',
                def: false,
                read: false,
                write: true
            },
            {
                id: 'command.flashLights',
                name: 'Flash Lights',
                type: 'boolean',
                role: 'button',
                def: false,
                read: false,
                write: true
            },
            {
                id: 'command.Climate',
                name: 'Climate',
                desc: 'Turn on climate to pre-set temperature',
                type: 'boolean',
                role: 'switch.power',
                read: true,
                write: true
            },
            {
                id: 'command.SetChargeLimit',
                name: 'Set Charge Limit',
                type: 'number',
                role: 'level',
                unit: '%',
                read: true,
                write: true,
                min: 50,
                max: 100
            },
            {
                id: 'command.ChargePort',
                name: 'Open / Close charge Port',
                type: 'boolean',
                role: 'switch.lock',
                read: true,
                write: true
            },
            {
                id: 'command.UnlockChargePort',
                name: 'Unlock charge Port',
                type: 'boolean',
                role: 'switch.lock',
                read: false,
                write: true
            },
            {
                id: 'command.Charging',
                name: 'Charging state',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true
            },
            {
                id: 'command.ValetMode',
                name: 'Enable valet Mode',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true
            },
            {id: 'command.ValetPin', name: 'Pin for Valet Mode', type: 'string', def: '????', read: true, write: true},
            {
                id: 'command.SpeedLimit',
                name: 'Limit max. car Speed',
                desc: 'Set Limit with "SpeedLimitValue"',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true
            },
            {
                id: 'command.SentryMode',
                name: 'Enable Sentry Mode',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true
            },
            {
                id: 'command.RemoteStart',
                name: 'Enable Remote Start',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true
            },
            {
                id: 'command.StartSoftwareUpdate',
                name: 'Start Software Update',
                desc: 'Software need to be available (Download 100%)',
                type: 'boolean',
                role: 'button.start',
                read: true,
                write: true
            },
            {
                id: 'command.seat_heater_left',
                name: 'Left seat heater',
                desc: 'Level of Seat heater (0 = off, 3 = max)',
                type: 'number',
                role: 'level',
                read: true,
                write: true,
                min: 0,
                max: 3
            },
            {
                id: 'command.seat_heater_right',
                name: 'Right seat heater',
                desc: 'Level of Seat heater (0 = off, 3 = max)',
                type: 'number',
                role: 'level',
                read: true,
                write: true,
                min: 0,
                max: 3
            },
            {
                id: 'command.steering_wheel_heater',
                name: 'Steering wheel heater',
                type: 'boolean',
                role: 'switch.enable',
                read: true,
                write: true
            },
            {
                id: 'command.windowVent',
                name: 'Vent Window',
                desc: 'Hint: Can also be used to close all windows',
                type: 'boolean',
                role: 'switch.lock.window',
                read: true,
                write: true
            },
            {
                id: 'command.openTrunk',
                name: 'Open trunk',
                type: 'boolean',
                role: 'button.open.door',
                read: true,
                write: true
            },
            {
                id: 'command.openFrunk',
                name: 'Open frunk (front trunk)',
                type: 'boolean',
                role: 'button.open.door',
                read: true,
                write: true
            },

            // states read only
            {
                id: 'chargeState.charging_state',
                name: 'Charging State',
                type: 'string',
                role: 'state',
                read: true,
                write: false
            },
            {
                id: 'chargeState.battery_level',
                name: 'Battery level',
                type: 'number',
                role: 'value.battery',
                unit: '%',
                read: true,
                write: false,
                min: 0,
                max: 100
            },


            {
                id: 'chargeState.scheduled_charging_start_time',
                name: 'Scheduled charge start Time',
                desc: 'Current Format: yyyy-MM-ddTHH:mm:ss (But can be changed by Tesla anytime)',
                type: 'string',
                role: 'date.start',
                read: true,
                write: false
            },
            {
                id: 'chargeState.battery_heater_on',
                name: 'Battery heater State',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'chargeState.minutes_to_full_charge',
                name: 'Minutes to fully Charge',
                type: 'number',
                role: 'value',
                read: true,
                write: false
            },
            {
                id: 'chargeState.fast_charger_present',
                name: 'Fast Charger connected',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'chargeState.usable_battery_level',
                name: 'Usable battery level',
                type: 'number',
                role: 'value.battery',
                unit: '%',
                read: true,
                write: false,
                min: 0,
                max: 100
            },
            {
                id: 'chargeState.charge_energy_added',
                name: 'Energy added with last Charge',
                type: 'number',
                role: 'value',
                unit: 'kWh',
                read: true,
                write: false
            },
            {
                id: 'chargeState.charger_voltage',
                name: 'Charger Voltage',
                type: 'number',
                role: 'value.voltage',
                unit: 'V',
                read: true,
                write: false
            },
            {
                id: 'chargeState.charger_power',
                name: 'Charger Power',
                type: 'number',
                role: 'value',
                unit: 'W',
                read: true,
                write: false
            },
            {
                id: 'chargeState.charge_current_request',
                name: 'Charge current requested',
                type: 'number',
                role: 'value.current',
                unit: 'A',
                read: true,
                write: false
            },
            {
                id: 'chargeState.charge_port_cold_weather_mode',
                name: 'Charge port cold weather mode',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },


            {
                id: 'climateState.inside_temp',
                name: 'Inside Temperature',
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                read: true,
                write: false
            },
            {
                id: 'climateState.outside_temp',
                name: 'Ouside Temperature',
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                read: true,
                write: false
            },
            {
                id: 'climateState.max_avail_temp',
                name: 'Max. available inside Temperature',
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                read: true,
                write: false
            },
            {
                id: 'climateState.min_avail_temp',
                name: 'Min. available inside Temperature',
                type: 'number',
                role: 'value.temperature',
                unit: '°C',
                read: true,
                write: false
            },
            {
                id: 'climateState.sun_roof_installed',
                name: 'Sun Roof Installed',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },

            {
                id: 'climateState.front_driver_window',
                name: 'Front driver window state',
                type: 'boolean',
                role: 'sensor.window',
                read: true,
                write: false
            },
            {
                id: 'climateState.front_passenger_window',
                name: 'Front passenger window state',
                type: 'boolean',
                role: 'sensor.window',
                read: true,
                write: false
            },
            {
                id: 'climateState.rear_driver_window',
                name: 'Rear driver window state',
                type: 'boolean',
                role: 'sensor.window',
                read: true,
                write: false
            },
            {
                id: 'climateState.rear_passenger_window',
                name: 'Front Passenger window state',
                type: 'boolean',
                role: 'sensor.window',
                read: true,
                write: false
            },


            {
                id: 'climateState.wiper_blade_heater',
                name: 'Wiper blade heater',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'climateState.side_mirror_heaters',
                name: 'Side mirrors heaters',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'climateState.is_preconditioning',
                name: 'Is preconditioning',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'climateState.smart_preconditioning',
                name: 'Smart preconditioning',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'climateState.is_auto_conditioning_on',
                name: 'Auto conditioning',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {
                id: 'climateState.battery_heater',
                name: 'Battery heater',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },

            {
                id: 'driveState.shift_state',
                name: 'Shift State',
                type: 'string',
                role: 'indicator',
                read: true,
                write: false
            },

            {
                id: 'driveState.power',
                name: 'Power',
                type: 'number',
                role: 'value.power.consumption',
                unit: 'Wh',
                read: true,
                write: false
            },
            {
                id: 'driveState.latitude',
                name: 'Current position latitude',
                type: 'number',
                role: 'value.gps.latitude',
                read: true,
                write: false
            },
            {
                id: 'driveState.longitude',
                name: 'Current position longitude',
                type: 'number',
                role: 'value.gps.longitude',
                read: true,
                write: false
            },
            {
                id: 'driveState.heading',
                name: 'Car heading',
                type: 'number',
                role: 'value.direction',
                unit: '°deg',
                read: true,
                write: false,
                min: 0,
                max: 360
            },
            {
                id: 'driveState.gps_as_of',
                name: 'Timestamp of last gps position',
                type: 'number',
                role: 'value.time',
                read: true,
                write: false
            },
            {
                id: 'vehicle.is_user_present',
                name: 'Is user present',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false
            },
            {id: 'vehicle.car_type', name: 'Car Type', type: 'string', role: 'text', read: true, write: false},

            {
                id: 'softwareUpdate.download_percentage',
                name: 'Software download in %',
                type: 'number',
                role: 'level',
                unit: '%',
                read: true,
                write: false,
                min: 0,
                max: 100
            },
            {
                id: 'softwareUpdate.expected_duration_sec',
                name: 'Update expected duration',
                type: 'number',
                role: 'value',
                unit: 'sec',
                read: true,
                write: false
            },
            {
                id: 'softwareUpdate.install_percentage',
                name: 'Installation in %',
                type: 'number',
                role: 'level',
                unit: '%',
                read: true,
                write: false,
                min: 0,
                max: 100
            },
            {
                id: 'softwareUpdate.status',
                name: 'Update Status',
                type: 'string',
                role: 'state',
                read: true,
                write: false
            },
            {
                id: 'softwareUpdate.version',
                name: 'Update Version',
                type: 'string',
                role: 'text',
                read: true,
                write: false
            },
        ];

        await this.createObjects(SleepStates);
        await this.createObjects(AwakeStates);
    }

    async installDistanceObjects(){
        const Adapter = this;
        let AwakeDependantStates = [
            // States that need information about Distance format
            {
                id: 'driveState.SpeedLimitMax',
                name: 'Speed limit Max settable',
                type: 'number',
                role: 'value.speed',
                unit: Adapter.distanceUnit,
                read: true,
                write: false
            },
            {
                id: 'driveState.SpeedLimitMin',
                name: 'Speed limit Min settable',
                type: 'number',
                role: 'value.speed',
                unit: Adapter.distanceUnit,
                read: true,
                write: false
            },
            {
                id: 'chargeState.battery_range',
                name: 'Battery Range',
                type: 'number',
                role: 'value.distance',
                unit: Adapter.distanceUnit.substr(0, Adapter.distanceUnit.indexOf('/')),
                read: true,
                write: false
            },
            {
                id: 'chargeState.est_battery_range',
                name: 'Estimated Battery Range',
                type: 'number',
                role: 'value.distance',
                unit: Adapter.distanceUnit.substr(0, Adapter.distanceUnit.indexOf('/')),
                read: true,
                write: false
            },
            {
                id: 'chargeState.ideal_battery_range',
                name: 'Ideal Battery Range',
                type: 'number',
                role: 'value.distance',
                unit: Adapter.distanceUnit.substr(0, Adapter.distanceUnit.indexOf('/')),
                read: true,
                write: false
            },
            {
                id: 'chargeState.charge_distance_added_rated',
                name: 'Distance added with Charge',
                type: 'number',
                role: 'value.distance',
                unit: Adapter.distanceUnit.substr(0, Adapter.distanceUnit.indexOf('/')),
                read: true,
                write: false
            },

            {
                id: 'driveState.speed',
                name: 'Speed',
                type: 'number',
                role: 'value.speed',
                unit: Adapter.distanceUnit,
                read: true,
                write: false
            },
            {
                id: 'vehicle.odometer',
                name: 'Odometer',
                type: 'number',
                role: 'value.distance',
                unit: Adapter.distanceUnit.substr(0, Adapter.distanceUnit.indexOf('/')),
                read: true,
                write: false
            }
        ];
        await this.overwriteObjects(AwakeDependantStates);
    }

    async installDependantObjects(vd){
        await this.overwriteObjects([{
            id: 'command.SetTemperature',
            name: 'Set Temperature',
            desc: 'Sets temperature of driver and passenger',
            type: 'number',
            role: 'value.temperature',
            unit: '°C',
            read: true,
            write: true,
            min: vd.climate_state.min_avail_temp,
            max: vd.climate_state.max_avail_temp
        }]);

        if(vd.vehicle_config.rear_seat_heaters === 1){
            await this.overwriteObjects([
                {
                    id: 'command.seat_heater_rear_center',
                    name: 'Rear center seat heater',
                    desc: 'Level of Seat heater (0 = off, 3 = max)',
                    type: 'number',
                    role: 'level',
                    read: true,
                    write: true,
                    min: 0,
                    max: 3
                },
                {
                    id: 'command.seat_heater_rear_left',
                    name: 'Rear left seat heater',
                    desc: 'Level of Seat heater (0 = off, 3 = max)',
                    type: 'number',
                    role: 'level',
                    read: true,
                    write: true,
                    min: 0,
                    max: 3
                },
                {
                    id: 'command.seat_heater_rear_right',
                    name: 'Rear right seat heater',
                    desc: 'Level of Seat heater (0 = off, 3 = max)',
                    type: 'number',
                    role: 'level',
                    read: true,
                    write: true,
                    min: 0,
                    max: 3
                },
            ]);
        }
        if(vd.vehicle_config.sun_roof_installed){
            await this.overwriteObjects([{
                id: 'command.SunRoofVent',
                name: 'Sun Roof Vent',
                type: 'boolean',
                role: 'switch.lock',
                read: true,
                write: true
            }]);
        }

        if(vd.vehicle_config.sun_roof_installed){
            await this.overwriteObjects([{
                id: 'climateState.sun_roof_percent_open',
                name: 'Sun Roof % open',
                type: 'number',
                role: 'level.tilt',
                unit: '%',
                read: true,
                write: false
            }]);
        }
    }

    async createObjects(objects){
        await objects.forEach(async (object) => {
            let id = object.id;
            delete object.id;
            this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: object,
                native: []
            });
        })
    }

    async overwriteObjects(objects){
        await objects.forEach(async (object) => {
            let id = object.id;
            delete object.id;
            this.setObjectAsync(id, {
                type: 'state',
                common: object,
                native: []
            });
        })
    }


    /**
     * type "number" | "string" | "boolean" | "array" | "object" | "mixed" | "file"
     */
    setStateCreate(id, name, role, state, type = 'string', write = true, read = true, unit = ''){
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

function decrypt(key, value){
    let result = '';
    for(let i = 0; i < value.length; ++i){
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}