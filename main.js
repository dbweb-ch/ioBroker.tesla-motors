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
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady(){ //
        const Adapter = this;
        this.subscribeStates('command.*');
        this.log.debug('Starting Tesla Motors');
        this.setState('info.connection', false, true);

        this.setObjectNotExists('authToken', {
            type: 'state',
            common: {name: 'authToken', type: 'string', role: 'indicator', read: false, write: false}
        })
        this.setObjectNotExists('refreshToken', {
            type: 'state',
            common: {name: 'refreshToken', type: 'string', role: 'indicator', read: false, write: false}
        })
        this.setObjectNotExists('tokenExpire', {
            type: 'state',
            common: {name: 'tokenExpire', type: 'string', role: 'indicator', read: false, write: false}
        })
        Adapter.log.debug("Check for Tokens and Expires");
        const authToken = await this.getStateAsync('authToken');
        const tokenExpire = await this.getStateAsync('tokenExpire');
        var Expires = new Date(tokenExpire.val);
        Expires.setDate(Expires.getDate() - 10);

        if(authToken.val.length == 0){
            this.GetNewToken(Adapter);
        }
        else if(Expires < new Date()){
            this.RefreshToken();
        }
        else{
            Adapter.setState('info.connection', true, true);
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
        }, 60 * 60 * 1000) // Todo: Make configurable and do the update more often when car is moving
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
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
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj){
        if(obj){
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        }
        else{
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state){
        const Adapter = this;
        Adapter.log.debug("State Change: " + id + " to " + state.val);
        const authToken = await Adapter.getStateAsync('authToken');
        const id_s = await Adapter.getStateAsync('vehicle.id_s');
        var options = {
            authToken: authToken.val,
            vehicleID: id_s.val
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
                    tjs.speedLimitSetLimit(options, state.val);
                    break;
            }
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        }
    }

    GetNewToken(){
        const Adapter = this;
        // No token, we try to get a token
        Adapter.log.info('Try to get a new token');
        tjs.login(Adapter.config.teslaUsername, Adapter.config.teslaPassword, function(err, result){
            if(result.error || !result.authToken){
                Adapter.log.error('Could not get token, stopping Adapter. error: ' + JSON.stringify(result.error));
                this.setForeignState("system.adapter." + this.namespace + ".alive", false);
                return;
            }
            Adapter.log.info('Recieved a new Token');
            Adapter.setState('authToken', result.authToken);
            Adapter.setState('refreshToken', result.refreshToken);
            var ExpireDate = new Date();
            ExpireDate.setSeconds(ExpireDate.getSeconds() + result.body.expires_in);
            Adapter.setState('tokenExpire', ExpireDate);
            Adapter.setState('info.connection', true, true);
        });
    }

    async RefreshToken(){
        const Adapter = this;
        const tokenExpire = await this.getStateAsync('tokenExpire');
        var Expires = new Date(tokenExpire.val);
        Expires.setDate(Expires.getDate() - 10);
        if(Expires < new Date()){
            const refreshToken = await this.getStateAsync('refreshToken');
            tjs.refreshToken(refreshToken.val, function(err, result){
                if(result.response.statusCode != 200){
                    Adapter.log.warn('Could not refresh Token, trying to get a new Token');
                    Adapter.setState('authToken', '');
                    Adapter.setState('info.connection', false, true);
                    GetNewToken();
                }
                else{
                    Adapter.log.info('Recieved a new authToken');
                    Adapter.setState('authToken', result.authToken);
                    Adapter.setState('refreshToken', result.refreshToken);
                    var ExpireDate = new Date();
                    ExpireDate.setSeconds(ExpireDate.getSeconds() + result.body.expires_in);
                    Adapter.setState('tokenExpire', ExpireDate);
                    Adapter.log.info("authToken updated. Now valid until " + ExpireDate.toLocaleDateString());
                    Adapter.setState('info.connection', true, true);
                }
            })
        }
    }

    /**
     * Get all infos that are available while car is sleeping
     * @constructor
     */
    async GetSleepingInfo(){
        const Adapter = this;
        Adapter.log.debug("Getting Sleeping Info");

        // Vehicle need to get synchronized as we need the id later!
        await new Promise(async function(resolve, reject){
            const authToken = await Adapter.getStateAsync('authToken');
            var options = {authToken: authToken.val};
            tjs.vehicle(options, function(err, vehicle){
                if(err){
                    Adapter.log.error('Invalid answer from Vehicle request. Error: ' + err);
                    return;
                    resolve();
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

        await new Promise(async function(resolve, reject){
            Adapter.log.debug('Waking up the car...');
            const authToken = await Adapter.getStateAsync('authToken');
            const id_s = await Adapter.getStateAsync('vehicle.id_s');
            var options = {
                authToken: authToken.val,
                vehicleID: id_s.val
            };
            tjs.wakeUp(options, function(err, data){
                Adapter.log.debug("Car is awake. Answer:" + JSON.stringify(data));
                Adapter.setState('vehicle.state', 'online');
                resolve();
            });
        })
    }

    async GetAllInfo(){
        const Adapter = this;
        await this.WakeItUp();
        Adapter.log.debug('Getting all States now');
        const authToken = await Adapter.getStateAsync('authToken');
        const id_s = await Adapter.getStateAsync('vehicle.id_s');
        var options = {
            authToken: authToken.val,
            vehicleID: id_s.val
        };
        tjs.chargeState(options, function(err, data){
            if(err){
                Adapter.log.error('Invalid answer from chargeState request. Error: ' + err);
                return;
            }
            Adapter.log.debug('chargeState Answer:' + JSON.stringify(data));

            Adapter.setStateCreate('chargeState.charging_state', data.charging_state, 'string', false);
            Adapter.setStateCreate('chargeState.battery_level', data.battery_level, 'number', false);
            Adapter.setStateCreate('chargeState.battery_range', data.battery_range, 'number', false);
            Adapter.setStateCreate('chargeState.est_battery_range', data.est_battery_range, 'number', false);
            Adapter.setStateCreate('chargeState.ideal_battery_range', data.ideal_battery_range, 'number', false);
            Adapter.setStateCreate('chargeState.charge_limit_soc', data.charge_limit_soc, 'number', false);
            Adapter.setStateCreate('chargeState.charge_port_door_open', data.charge_port_door_open, 'boolean', false);
            Adapter.setStateCreate('chargeState.scheduled_charging_start_time', data.scheduled_charging_start_time, 'string', false);
            Adapter.setStateCreate('chargeState.battery_heater_on', data.battery_heater_on, 'boolean', false);

            if(EXTENDED_STATES){
                Adapter.setStateCreate('chargeState.fast_charger_present', data.fast_charger_present, 'boolean', false);
                Adapter.setStateCreate('chargeState.usable_battery_level', data.usable_battery_level, 'number', false);
                Adapter.setStateCreate('chargeState.charge_energy_added', data.charge_energy_added, 'number', false);
                Adapter.setStateCreate('chargeState.charge_miles_added_rated', data.charge_miles_added_rated, 'number', false);
                Adapter.setStateCreate('chargeState.charger_voltage', data.charger_voltage, 'number', false);
                Adapter.setStateCreate('chargeState.charger_power', data.charger_power, 'number', false);
                Adapter.setStateCreate('chargeState.charge_current_request', data.charge_current_request, 'number', false);
            }
        })

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
        })

        tjs.driveState(options, function(err, data){
            if(err){
                Adapter.log.error('Invalid answer from driveState request. Error: ' + err);
                return;
            }
            Adapter.log.debug('driveState Answer:' + JSON.stringify(data));

            Adapter.setStateCreate('driveState.shift_state', data.shift_state, 'string', false);
            Adapter.setStateCreate('driveState.speed', data.speed, 'number', false);
            Adapter.setStateCreate('driveState.power', data.power, 'number', false);
            Adapter.setStateCreate('driveState.latitude', data.latitude, 'number', false);
            Adapter.setStateCreate('driveState.longitude', data.longitude, 'number', false);
            Adapter.setStateCreate('driveState.heading', data.heading, 'number', false);
            Adapter.setStateCreate('driveState.gps_as_of', data.gps_as_of, 'number', false);
        })
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
     * @param type "number" | "string" | "boolean" | "array" | "object" | "mixed" | "file"
     */
    setStateCreate(id, state, type, write, read, role){
        type = type || 'string';
        write = write || true;
        read = read || true;
        role = role || '';
        this.setObjectNotExists(id, {
            type: 'state',
            common: {name: id.substring(id.lastIndexOf('.') + 1), type: type, role: role, read: read, write: write}
        })
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