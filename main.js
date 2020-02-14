'use strict';

const utils = require('@iobroker/adapter-core');
const tjs = require('teslajs');
const tools = require(utils.controllerDir + '/lib/tools.js');

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

        // Timeouts and intervals
        this.RefreshTokenTimeout = null;
        this.RefreshRequestTimeout = null;
        this.GetStandbyInfoTimeout = null;
        this.RefreshAllInfoTimeout = null;
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady(){ //
        this.log.debug('Starting Tesla Motors');
        const Adapter = this;
        await Adapter.setStateAsync('info.connection', false, true);

        this.log.debug('All Objects installed, setting up tasks now');

        this.subscribeStates('command.*');

        // Setup Tasks
        await Adapter.RefreshTokenTask();
        await Adapter.RefreshStandbyInfoTask();
        await Adapter.RefreshAllInfoTask();
        await Adapter.CheckRefreshRequestTask();
    }

    onUnload(callback){
        const Adapter = this;
        try{
            this.log.info('cleaned everything up...');
            if(Adapter.RefreshTokenTimeout){
                clearTimeout(Adapter.RefreshTokenTimeout);
            }
            if(Adapter.RefreshRequestTimeout){
                clearTimeout(Adapter.RefreshRequestTimeout);
            }
            if(Adapter.GetStandbyInfoTimeout){
                clearTimeout(Adapter.GetStandbyInfoTimeout);
            }
            if(Adapter.RefreshAllInfoTimeout){
                clearTimeout(Adapter.RefreshAllInfoTimeout);
            }

            callback();
        }catch(e){
            callback();
        }
    }

    async RefreshTokenTask(){
        const Adapter = this;
        Adapter.log.debug('Checking if token is valid');
        await this.RefreshToken();
        // Check again in 1 Day.
        this.RefreshTokenTimeout = setTimeout(() => Adapter.RefreshTokenTask(), 24 * 60 * 60 * 1000);
    }

    async RefreshStandbyInfoTask(){
        const Adapter = this;
        await Adapter.GetStandbyInfo();
        // Check every minute the standby Info
        this.GetStandbyInfoTimeout = setTimeout(() => Adapter.RefreshStandbyInfoTask(), 60 * 1000);
    }

    async CheckRefreshRequestTask(){
        const Adapter = this;
        if(this.refreshData){
            this.log.debug('Refresh of full Data requested');
            this.refreshData = false;
            await this.GetAllInfo();
        }
        this.RefreshRequestTimeout = setTimeout(() => Adapter.CheckRefreshRequestTask(), 1000);
    }

    async RefreshAllInfoTask(){
        const Adapter = this;
        this.log.debug('Refresh of all in Task run. Current wakeupPlan is "' + Adapter.config.wakeupPlan + '"');
        // Setting up Timeouts based on wakeup-Plan
        switch(Adapter.config.wakeupPlan){
            case 'aggressive':
                await Adapter.GetAllInfo();
                Adapter.RefreshAllInfoTimeout = setTimeout(() => Adapter.RefreshAllInfoTask(), 60 * 1000); // once per minute
                break;
            case 'temperate':
                await Adapter.GetAllInfo();
                Adapter.RefreshAllInfoTimeout = setTimeout(() => Adapter.RefreshAllInfoTask(), 60 * 60 * 1000); // once per hour
                break;
            case 'off':
                // Only get data when something changes or car is awake anyway (Done in GetSleepingInfo)
                break;
            case 'smart':
            default:
                /* Theory:
                 * When car wakes up, there is something happening.
                 * So if car woke up, get data every minute for 10 minutes.
                 * If nothing happened (Car start, Climate start, Charging) leave car alone to let him fall asleep.
                 * If not went to sleep, request data and wait again 15 minutes.
                 * But: If last wake up is more than 12 hours ago, request state!
                 *
                 * The whole thing is 1-minute-timer-based, so we do this stuff every minute
                 */
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
                    Adapter.log.debug("Get all info because last Wakeup time is only " + Minutes + "ago.");
                    await Adapter.GetAllInfo();
                }
                else if(Minutes > 10 && Minutes <= 25){
                    // Don't do anything, try to let the car sleep...
                    Adapter.log.debug("Don't wake up the car and let it go to sleep. Minutes since last woke up: " + Minutes);
                }
                else if(Minutes > 25){
                    // Check if car is still awake. If so, request once and then go back to "let it sleep"
                    let standby = await Adapter.getStateAsync('command.standby');
                    if(standby && !standby.val && standby.ack){
                        Adapter.log.debug("Car is still awake after 25 Minutes. Retry to let him fall asleep for 15 minutes");
                        await Adapter.GetAllInfo();
                        this.lastTimeWokeUp = new Date();
                        this.lastTimeWokeUp.setMinutes(new Date().getMinutes() - 11);
                    }
                    else{
                        Adapter.log.debug("Car fall asleep successfully, will leave him alone for a while...");
                    }
                }
                else if(Minutes > 60 * 12){
                    Adapter.log.debug("Car was sleeping for > 12 hours, Update information");
                    await Adapter.GetAllInfo();
                }

                Adapter.RefreshAllInfoTimeout = setTimeout(() => Adapter.RefreshAllInfoTask(), 60 * 1000); // check every minute
                break;
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
                        let charge = await tjs.startChargeAsync(options).catch((err) => {
                            Adapter.log.error('Err:' + err);
                        });
                        if(charge.result === false){
                            Adapter.setState('command.Charging', false, true);
                        }
                        else{
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
            let password = tools.decrypt('rEYbFGzsXW8QBx5', msg.message.teslaPassword);
            if(Adapter.config.teslaUsername.length == 0 || Adapter.config.teslaPassword.length == 0){
                Adapter.log.error("Your authentification token is not valid or expired. Can't get a new token because you did not store username / password. Please request a new token in Adapter Configuration");
                Adapter.sendTo(msg.from, msg.command, {success: false}, msg.callback);
                return;
            }
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
            Adapter.sendTo(msg.from, msg.command, {success: true, login: Response, vehicles: Vehicles}, msg.callback);
        }
    }

    async GetNewToken(){
        const Adapter = this;
        // No token, we try to get a token
        if(Adapter.config.teslaUsername.length == 0 || Adapter.config.teslaPassword.length == 0){
            Adapter.log.error("Your authentification token is not valid or expired. Can't get a new token because you did not store username / password. Please request a new token in Adapter Configuration");
            return;
        }
        Adapter.log.info('Try to get a new token');
        await tjs.login(Adapter.config.teslaUsername, tools.decrypt('rEYbFGzsXW8QBx5', Adapter.config.teslaPassword), async (err, result) => {
            if(!result || !result.response || result.response.statusCode !== 200 || !result.authToken || !result.refreshToken){
                Adapter.log.warn('Could not get token, Adapter cant read anything.');
            }
            else{
                await Adapter.SetNewToken(result.authToken, result.refreshToken, result.body.expires_in);
            }
        });
    }

    async RefreshToken(){
        const Adapter = this;
        Adapter.log.debug("Check for Tokens and Expires");
        let Expires = new Date(Adapter.config.tokenExpire);
        Expires.setDate(Expires.getDate() - 10); // Refresh 10 days before expire
        if(Adapter.config.authToken.length > 0 && Expires < new Date()){
            tjs.refreshToken(Adapter.config.refreshToken, async (err, result) => {
                if(!result || !result.response || result.response.statusCode !== 200){
                    Adapter.log.warn('Could not refresh Token, trying to get a new Token');
                    await Adapter.setStateAsync('info.connection', false, true);
                    await Adapter.GetNewToken();
                }
                else{
                    await Adapter.SetNewToken(result.authToken, result.refreshToken, result.body.expires_in);
                }
            })
        }
        else if(Adapter.config.authToken.length === 0){
            await Adapter.setStateAsync('info.connection', false, true);
        }
        else{
            await Adapter.setStateAsync('info.connection', true, true);
        }
    }

    async SetNewToken(authToken, refreshToken, tokenExpire){
        const Adapter = this;
        Adapter.log.info('Setting a new Token, Adapter will reboot after this automatically');

        let ExpireDate = new Date();
        ExpireDate.setSeconds(ExpireDate.getSeconds() + Number(tokenExpire));
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
    async GetStandbyInfo(){
        const Adapter = this;
        const State = await Adapter.getStateAsync('info.connection');
        if(!State){
            Adapter.log.warn('You tried to get States, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        Adapter.log.debug("Getting Standby Info");

        await new Promise(async resolve => {
            let vehicleIndex = 0;
            Adapter.config.vehicles.forEach(function(vehicle, idx){
                if(vehicle["id_s"] === Adapter.config.vehicle_id_s){
                    vehicleIndex = idx;
                }
            });
            let options = {
                authToken: Adapter.config.authToken,
                carIndex: vehicleIndex
            };
            let vehicle;
            try{
                vehicle = await tjs.vehicleAsync(options);
            }
            catch(err){
                Adapter.log.warn('Invalid answer from Vehicle request. Error: ' + err);
                return resolve();
            }

            Adapter.log.debug('vehicle Answer:' + JSON.stringify(vehicle));

            await Adapter.setStateAsync('vehicle.id_s', vehicle.id_s, true);
            await Adapter.setStateAsync('vehicle.vin', vehicle.vin, true);
            await Adapter.setStateAsync('vehicle.display_name', vehicle.display_name, true);
            await Adapter.setStateAsync('command.standby', 'online' !== vehicle.state, true);
            await Adapter.setStateAsync('vehicle.option_codes', vehicle.option_codes, true);
            await Adapter.setStateAsync('vehicle.color', vehicle.color, true);

            if(vehicle.state === 'online' && !this.lastWakeState){
                // Car was sleeping before, but woke up now. So we trigger a refresh of data
                this.refreshData = true;
                this.lastTimeWokeUp = new Date();
            }
            this.lastWakeState = vehicle.state === 'online';
            resolve();
        });
    }

    async WakeItUp(){
        const Adapter = this;
        const State = await Adapter.getStateAsync('info.connection');
        if(!State){
            Adapter.log.warn('You tried to wake up the car, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        // Check if in standby
        await Adapter.GetStandbyInfo();
        let standby;
        standby = await Adapter.getStateAsync('command.standby');
        if(standby && !standby.val && standby.ack){
            Adapter.log.debug("Wanted to wake up the car, but car is already awake.");
            return;
        }

        await new Promise(async resolve => {
            Adapter.log.debug('Waking up the car...');
            let options = {
                authToken: Adapter.config.authToken,
                vehicleID: Adapter.config.vehicle_id_s
            };
            await tjs.wakeUp(options, async (err, data) => {
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
                }
                else{
                    Adapter.log.debug("Car is Awake");
                    await Adapter.setStateAsync('command.standby', false, true);
                    Adapter.WakeItUpRetryCount = 30;
                }
            });
            resolve();
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
        let vd;
        try{
            vd = await new Promise(async (resolve, reject) => {
                tjs.vehicleData(options, (err, data) => {
                    Adapter.log.debug("Answer from vehicleState:" + JSON.stringify(data) + JSON.stringify(err));
                    if(err){
                        reject(err);
                    }
                    else{
                        resolve(data);
                    }
                });
            });
        }
        catch(error){
            Adapter.log.warn('Could not retrieve Data from the Car! Response: ' + error);
            return;
        }

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
        else if(vd.charge_state.charging_state === 'Disconnected' || vd.charge_state.charging_state === 'Stopped'){
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
        Adapter.setState('driveState.gps_as_of', vd.drive_state.gps_as_of * 1000, true);


        Adapter.setState('vehicle.is_user_present', vd.vehicle_state.is_user_present, true);
        Adapter.setState('vehicle.odometer', Adapter.m_km(vd.vehicle_state.odometer), true);
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


            await Adapter.extendObjectAsync('command.SpeedLimitValue', {
                type: 'state',
                common: {
                    name: 'Limit car Speed',
                    desc: 'Min ' + spmin + Adapter.distanceUnit + ', Max ' + spmax + Adapter.distanceUnit,
                    type: 'number',
                    role: 'state',
                    unit: Adapter.distanceUnit,
                    write: true,
                    min: spmin,
                    max: spmax
                },
                native: {}
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


    async installDistanceObjects(){
        const Adapter = this;
        const rangeUnit = Adapter.distanceUnit.substr(0, Adapter.distanceUnit.indexOf('/'));
        await this.extendObjectAsync('driveState.SpeedLimitMax',
            {common: {unit: Adapter.distanceUnit}}
        );
        await this.extendObjectAsync('driveState.SpeedLimitMin',
            {common: {unit: Adapter.distanceUnit}}
        );
        await this.extendObjectAsync('chargeState.battery_range',
            {common: {unit: rangeUnit}}
        );
        await this.extendObjectAsync('chargeState.est_battery_range',
            {common: {unit: rangeUnit}}
        );
        await this.extendObjectAsync('chargeState.ideal_battery_range',
            {common: {unit: rangeUnit}}
        );
        await this.extendObjectAsync('chargeState.charge_distance_added_rated',
            {common: {unit: rangeUnit}}
        );
        await this.extendObjectAsync('driveState.speed',
            {common: {unit: Adapter.distanceUnit}}
        );
        await this.extendObjectAsync('vehicle.odometer',
            {common: {unit: rangeUnit}}
        );
    }

    async installDependantObjects(vd){
        await this.extendObjectAsync('command.SetTemperature', {
            common: {
                min: vd.climate_state.min_avail_temp,
                max: vd.climate_state.max_avail_temp
            }
        });

        if(vd.vehicle_config.rear_seat_heaters === 1){
            await this.setObjectNotExistsAsync('command.seat_heater_rear_center', {
                type: "state",
                common: {
                    name: 'Rear center seat heater',
                    desc: 'Level of Seat heater (0 = off, 3 = max)',
                    type: 'number',
                    role: 'level',
                    write: true,
                    min: 0,
                    max: 3
                },
                native: {}
            });
            await this.setObjectNotExistsAsync('command.seat_heater_rear_left', {
                type: "state",
                common: {
                    name: 'Rear left seat heater',
                    desc: 'Level of Seat heater (0 = off, 3 = max)',
                    type: 'number',
                    role: 'level',
                    read: true,
                    write: true,
                    min: 0,
                    max: 3
                },
                native: {}
            });
            await this.setObjectNotExistsAsync('command.seat_heater_rear_right', {
                type: "state",
                common: {
                    name: 'Rear right seat heater',
                    desc: 'Level of Seat heater (0 = off, 3 = max)',
                    type: 'number',
                    role: 'level',
                    read: true,
                    write: true,
                    min: 0,
                    max: 3
                },
                native: {}
            });
        }
        if(vd.vehicle_config.sun_roof_installed){
            await this.setObjectNotExistsAsync('command.SunRoofVent', {
                type: "state",
                common: {
                    name: 'Sun Roof Vent',
                    type: 'boolean',
                    role: 'switch.lock',
                    write: true
                },
                native: {}
            });
        }

        if(vd.vehicle_config.sun_roof_installed){
            await this.setObjectNotExistsAsync('climateState.sun_roof_percent_open', {
                type: "state",
                common: {
                    name: 'Sun Roof % open',
                    type: 'number',
                    role: 'level.tilt',
                    unit: '%',
                    write: false
                },
                native: {}
            });
        }
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

function Sleep(milliseconds){
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
