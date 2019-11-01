'use strict';

const utils = require('@iobroker/adapter-core');
const tjs = require('teslajs');

const EXTENDED_STATES = false;

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

        var Expires = new Date(Adapter.config.tokenExpire);
        Expires.setDate(Expires.getDate() - 10);

        if(Adapter.config.authToken.length === 0){
            this.GetNewToken();
        }
        else if(Expires < new Date()){
            this.RefreshToken();
        }
        else{
            await Adapter.setStateAsync('info.connection', true, true);
            Adapter.log.debug("Connected to Tesla");
        }
        Adapter.GetSleepingInfo();
        Adapter.GetAllInfo();
        Adapter.log.debug("Everything intialized, starting Intervals");
        setInterval(function(){
            Adapter.RefreshToken();
        }, 24 * 60 * 60 * 1000);

        setInterval(function(){
            Adapter.GetSleepingInfo();
        }, 1 * 60 * 1000);

        setInterval(function(){
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
        Adapter.log.debug("State Change: " + id + " to " + state.val);

        const State = await Adapter.getStateAsync('info.connection');
        if(!State){
            Adapter.log.warn('You tried to set a State, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        var options = {
            authToken: Adapter.config.authToken,
            vehicleID: Adapter.config.vehicle_id_s
        };
        const currentId = id.substring(Adapter.namespace.length + 1);
        if(state && !state.ack){
            switch(currentId){
                case 'command.wakeUp':
                    if(state.val){
                        tjs.wakeUp(options);
                        Adapter.setState('command.wakeUp', false);
                    }
                    break;
                case 'command.doorLock':
                    if(state.val){
                        tjs.doorLock(options);
                    }
                    else{
                        tjs.doorUnlock(options);
                    }
                    break;
                case 'command.honkHorn':
                    if(state.val){
                        tjs.honkHorn(options);
                        Adapter.setState('command.honkHorn', false);
                    }
                    break;
                case 'command.Climate':
                    if(state.val){
                        tjs.climateStart(options);
                    }
                    else{
                        tjs.climateStop(options);
                    }
                    break;
                case 'command.SetTemperature':
                    tjs.setTemps(options, state.val, state.val);
                    break;
                case 'command.SetChargeLimit':
                    if(parseInt(state.val) > 100 || parseInt(state.val) < 0){
                        Adapter.setState('command.SetChargeLimit', 80);
                    }
                    else tjs.setChargeLimit(options, state.val);
                    break;
                case 'command.ChargePort':
                    if(state.val){
                        tjs.openChargePort(options);
                    }
                    else{
                        tjs.closeChargePort(options);
                    }
                    break;
                case 'command.Charging':
                    if(state.val){
                        tjs.startCharge(options);
                    }
                    else{
                        tjs.stopCharge(options);
                    }
                    break;
                case 'command.ValetMode':
                    const ValetPin = await Adapter.getStateAsync('command.ValetPin');
                    if(!ValetPin){
                        Adapter.setStateCreate('command.ValetPin', '????');
                        break;
                    }
                    if(/^\d{4}$/.test(ValetPin.val)){
                        tjs.setValetMode(options, state.val, ValetPin.val);
                    }
                    else{
                        if(!state.val){ // Ensure valet mode is off anyway!
                            tjs.setValetMode(options, false, '0000');
                            tjs.resetValetPin(options);
                        }
                        Adapter.setState('command.ValetPin', '????');
                    }
                    break;
                case 'command.SpeedLimit':
                    if(state.val){
                        tjs.speedLimitActivate(options);
                    }
                    else{
                        tjs.speedLimitDeactivate(options);
                    }
                    break;
                case 'command.SpeedLimitValue':
                    tjs.speedLimitSetLimit(options, Adapter.km_m(state.val));
                    break;
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

            let Response = await new Promise(async function(resolve, reject){
                tjs.login(username, password, async function(err, result){
                    if(result.error || !result.authToken){
                        Adapter.log.info('Username or Password invalid' + result.body.response);
                        await Adapter.setStateAsync('info.connection', false, true);
                        resolve({
                            error: true,
                            msg: 'Could not retrieve token, Error from Tesla: ' + result.body.response});
                        return;
                    }
                    Adapter.log.info('Recieved a new Token');
                    let ExpireDate = new Date();
                    ExpireDate.setSeconds(ExpireDate.getSeconds() + result.body.expires_in);
                    await Adapter.setStateAsync('info.connection', true, true);
                    resolve({
                        error: false,
                        authToken: result.authToken,
                        refreshToken: result.refreshToken,
                        tokenExpire: ExpireDate.getTime(),
                        msg: 'Success'});
                });
            });
            let Vehicles = {};
            if(!Response.error){
                Vehicles = await new Promise(async function(resolve, reject){
                    let options = {authToken: Response.authToken};
                    tjs.vehicles(options, function(err, vehicles){
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

    GetNewToken(){
        const Adapter = this;
        // No token, we try to get a token
        Adapter.log.info('Try to get a new token');
        tjs.login(Adapter.config.teslaUsername, Adapter.config.teslaPassword, async function(err, result){
            if(result.error || !result.authToken){
                Adapter.log.warn('Could not get token, Adapter cant read anything.');
            }
            else {
                await Adapter.SetNewToken(result.authToken, result.refreshToken, result.body.expires_in);
            }
        });
    }

    async RefreshToken(){
        const Adapter = this;

        let Expires = new Date(Adapter.config.tokenExpire);
        Expires.setDate(Expires.getDate() - 10); // Refresh 10 days before expire
        if(Expires < new Date()){
            tjs.refreshToken(Adapter.config.refreshToken, async function(err, result){
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

        await Adapter.setForeignObjectAsync('system.adapter.tesla-motors.0',obj);

        await Adapter.setStateAsync('info.connection', true, true);
    }

    /**
     * Get all infos that are available while car is sleeping
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
        await new Promise(async function(resolve, reject){
            let options = {authToken: Adapter.config.authToken};
            tjs.vehicle(options, function(err, vehicle){
                if(err){
                    Adapter.log.error('Invalid answer from Vehicle request. Error: ' + err);
                    resolve();
                    return;
                }
                Adapter.log.debug('vehicle Answer:' + JSON.stringify(vehicle));

                Adapter.setStateCreate('vehicle.id_s', vehicle.id_s, 'string', false);
                Adapter.setStateCreate('vehicle.vin', vehicle.vin, 'string', false);
                Adapter.setStateCreate('vehicle.display_name', vehicle.display_name, 'string', false);
                Adapter.setStateCreate('vehicle.state', vehicle.state, 'string', false);
                if(EXTENDED_STATES){
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
        await new Promise(async function(resolve, reject){
            Adapter.log.debug('Waking up the car...');
            let options = {
                authToken: Adapter.config.authToken,
                vehicleID: Adapter.config.vehicle_id_s
            };
            tjs.wakeUp(options, function(err, data){
                Adapter.log.debug("Car is awake. Answer:" + JSON.stringify(data) + JSON.stringify(err));
                Adapter.setState('vehicle.state', 'online');
                resolve();
            });
        })
    }

    async GetAllInfo(){
        const Adapter = this;
        const State = await Adapter.getStateAsync('info.connection');
        if(!State){
            Adapter.log.warn('You tried to wake up the car, but there is currently no valid Token, please configure Adapter first!');
            return;
        }
        await this.WakeItUp();
        Adapter.log.debug('Getting all States now');
        let options = {
            authToken: Adapter.config.authToken,
            vehicleID: Adapter.config.vehicle_id_s
        };
        tjs.chargeState(options, function(err, data){
            if(err){
                Adapter.log.error('Invalid answer from chargeState request. Error: ' + err);
                return;
            }
            Adapter.log.debug('chargeState Answer:' + JSON.stringify(data));

            Adapter.setStateCreate('chargeState.charging_state', data.charging_state, 'string', false);
            Adapter.setStateCreate('chargeState.battery_level', data.battery_level, 'number', false);
            Adapter.setStateCreate('chargeState.battery_range', Adapter.m_km(data.battery_range), 'number', false);
            Adapter.setStateCreate('chargeState.est_battery_range', Adapter.m_km(data.est_battery_range), 'number', false);
            Adapter.setStateCreate('chargeState.ideal_battery_range', Adapter.m_km(data.ideal_battery_range), 'number', false);
            Adapter.setStateCreate('chargeState.charge_limit_soc', data.charge_limit_soc, 'number', false);
            Adapter.setStateCreate('chargeState.charge_port_door_open', data.charge_port_door_open, 'boolean', false);
            Adapter.setStateCreate('chargeState.scheduled_charging_start_time', data.scheduled_charging_start_time, 'string', false);
            Adapter.setStateCreate('chargeState.battery_heater_on', data.battery_heater_on, 'boolean', false);

            if(EXTENDED_STATES){
                Adapter.setStateCreate('chargeState.fast_charger_present', data.fast_charger_present, 'boolean', false);
                Adapter.setStateCreate('chargeState.usable_battery_level', data.usable_battery_level, 'number', false);
                Adapter.setStateCreate('chargeState.charge_energy_added', data.charge_energy_added, 'number', false);
                Adapter.setStateCreate('chargeState.charge_distance_added_rated', Adapter.m_km(data.charge_miles_added_rated), 'number', false);
                Adapter.setStateCreate('chargeState.charger_voltage', data.charger_voltage, 'number', false);
                Adapter.setStateCreate('chargeState.charger_power', data.charger_power, 'number', false);
                Adapter.setStateCreate('chargeState.charge_current_request', data.charge_current_request, 'number', false);
            }
        });

        tjs.climateState(options, function(err, data){
            if(err){
                Adapter.log.error('Invalid answer from climateState request. Error: ' + err);
                return;
            }
            Adapter.log.debug('climateState Answer:' + JSON.stringify(data));

            Adapter.setStateCreate('climateState.inside_temp', data.inside_temp, 'number', false);
            Adapter.setStateCreate('climateState.outside_temp', data.outside_temp, 'number', false);
            Adapter.setStateCreate('climateState.driver_temp_setting', data.driver_temp_setting, 'number', false);
            Adapter.setStateCreate('climateState.passenger_temp_setting', data.passenger_temp_setting, 'number', false);
            Adapter.setStateCreate('climateState.is_climate_on', data.is_climate_on, 'boolean', false);
            if(EXTENDED_STATES){
                Adapter.setStateCreate('climateState.steering_wheel_heater', data.steering_wheel_heater, 'boolean', false);
                Adapter.setStateCreate('climateState.wiper_blade_heater', data.wiper_blade_heater, 'boolean', false);
                Adapter.setStateCreate('climateState.side_mirror_heaters', data.side_mirror_heaters, 'boolean', false);
                Adapter.setStateCreate('climateState.is_preconditioning', data.is_preconditioning, 'boolean', false);
                Adapter.setStateCreate('climateState.smart_preconditioning', data.smart_preconditioning, 'boolean', false);
                Adapter.setStateCreate('climateState.is_auto_conditioning_on', data.is_auto_conditioning_on, 'boolean', false);
            }
        });

        tjs.driveState(options, function(err, data){
            if(err){
                Adapter.log.error('Invalid answer from driveState request. Error: ' + err);
                return;
            }
            Adapter.log.debug('driveState Answer:' + JSON.stringify(data));

            Adapter.setStateCreate('driveState.shift_state', data.shift_state, 'string', false);
            Adapter.setStateCreate('driveState.speed', Adapter.m_km(data.speed), 'number', false);
            Adapter.setStateCreate('driveState.power', data.power, 'number', false);
            Adapter.setStateCreate('driveState.latitude', data.latitude, 'number', false);
            Adapter.setStateCreate('driveState.longitude', data.longitude, 'number', false);
            Adapter.setStateCreate('driveState.heading', data.heading, 'number', false);
            Adapter.setStateCreate('driveState.gps_as_of', data.gps_as_of, 'number', false);
        })
    }

    m_km(value){
        if(this.config.distanceUnit == 'miles') return value;
        else return Math.round(value * 1.60934);
    }
    km_m(value){
        if(this.config.distanceUnit == 'miles') return value;
        else return Math.round(value / 1.60934);
    }
    initCommandObjects(){
        this.setStateCreate('command.wakeUp', false, 'boolean', true, true, 'button');
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
        this.setState(id, state);
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