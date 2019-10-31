'use strict';

const utils = require('@iobroker/adapter-core');
const tjs = require('teslajs');

const EXTENDED_STATES = false;

class TeslaMotors extends utils.Adapter {

    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    constructor(options) {
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
    async onReady() {
        const Adapter = this;
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
        else {
            Adapter.setState('info.connection', true, true);
            Adapter.log.debug("Connected to Tesla");
        }
        Adapter.initObject();
        Adapter.GetSleepingInfo();
        Adapter.log.debug("Everything intialized, starting Intervals");
        setInterval(function(){
            Adapter.RefreshToken();
        }, 24*60*60*1000);

        setInterval(function(){
            Adapter.GetSleepingInfo();
        }, 1 * 60 * 1000);

        Adapter.GetAllInfo();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.log.info('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state) {
            // The state was changed
            this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            // The state was deleted
            this.log.info(`state ${id} deleted`);
        }
    }

    GetNewToken(){
        const Adapter = this;
        // No token, we try to get a token
        Adapter.log.info('Try to get a new token');
        tjs.login(Adapter.config.teslaUsername, Adapter.config.teslaPassword, function(err, result) {
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
            tjs.refreshToken(refreshToken.val,function(err, result){
                if(result.response.statusCode != 200){
                    Adapter.log.warn('Could not refresh Token, trying to get a new Token');
                    Adapter.setState('authToken', '');
                    Adapter.setState('info.connection', false, true);
                    GetNewToken();
                }
                else {
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
        await new Promise(async function(resolve, reject) {
            const authToken = await Adapter.getStateAsync('authToken');
            var options = { authToken: authToken.val };
            tjs.vehicle(options, function (err, vehicle) {
                if(err){
                    Adapter.log.error('Invalid answer from Vehicle request. Error: ' + err);
                    return;
                    resolve();
                }
                Adapter.log.debug('vehicle Answer:' + JSON.stringify(vehicle));
                Adapter.setState('vehicle.id_s', vehicle.id_s);
                Adapter.setState('vehicle.vin', vehicle.vin);
                Adapter.setState('vehicle.display_name', vehicle.display_name);
                Adapter.setState('vehicle.state', vehicle.state);
                if(EXTENDED_STATES){
                    Adapter.setState('vehicle.option_codes', vehicle.option_codes);
                    Adapter.setState('vehicle.color', vehicle.color);
                }
                resolve();
            });
        })
    }

    async WakeItUp(){
        const Adapter = this;
        Adapter.log.debug('Waking up the car...');
        const authToken = await Adapter.getStateAsync('authToken');
        const id_s = await Adapter.getStateAsync('vehicle.id_s');
        var options = {
            authToken: authToken.val,
            vehicleID: id_s.val };
        tjs.wakeUp(options, function (err, data) {
            Adapter.log.debug("Car is awake. Answer:" + JSON.stringify(data));
        });
    }

    async GetAllInfo(){
        const Adapter = this;
        await this.WakeItUp();
        const authToken = await Adapter.getStateAsync('authToken');
        const id_s = await Adapter.getStateAsync('vehicle.id_s');
        var options = {
            authToken: authToken.val,
            vehicleID: id_s.val };

        tjs.chargeState(options, function (err, data) {
            if(err){
                Adapter.log.error('Invalid answer from chargeState request. Error: ' + err);
                return;
            }
            Adapter.log.debug('chargeState Answer:' + JSON.stringify(data));

            Adapter.setState('chargeState.charging_state', data.charging_state);
            Adapter.setState('chargeState.battery_level', data.battery_level);
            Adapter.setState('chargeState.battery_range', data.battery_range);
            Adapter.setState('chargeState.est_battery_range', data.est_battery_range);
            Adapter.setState('chargeState.ideal_battery_range', data.ideal_battery_range);
            Adapter.setState('chargeState.charge_limit_soc', data.charge_limit_soc);
            Adapter.setState('chargeState.charge_port_door_open', data.charge_port_door_open);
            Adapter.setState('chargeState.scheduled_charging_start_time', data.scheduled_charging_start_time);
            Adapter.setState('chargeState.battery_heater_on', data.battery_heater_on);

            if(EXTENDED_STATES){
                Adapter.setState('chargeState.fast_charger_present', data.fast_charger_present);
                Adapter.setState('chargeState.usable_battery_level', data.usable_battery_level);
                Adapter.setState('chargeState.charge_energy_added', data.charge_energy_added);
                Adapter.setState('chargeState.charge_miles_added_rated', data.charge_miles_added_rated);
                Adapter.setState('chargeState.charger_voltage', data.charger_voltage);
                Adapter.setState('chargeState.charger_power', data.charger_power);
                Adapter.setState('chargeState.charge_current_request', data.charge_current_request);
            }
        })
    }

    initObject(){
        // Vehicle
        this.setObjectNotExists('vehicle.id_s', {
            type: 'state',
            common: {name: 'id_s', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('vehicle.vin', {
            type: 'state',
            common: {name: 'vin', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('vehicle.display_name', {
            type: 'state',
            common: {name: 'display_name', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('vehicle.state', {
            type: 'state',
            common: {name: 'state', type: 'string', role: 'indicator', read: true, write: false}
        })
        if(EXTENDED_STATES){
            this.setObjectNotExists('vehicle.option_codes', {
                type: 'state',
                common: {name: 'option_codes', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('vehicle.color', {
                type: 'state',
                common: {name: 'color', type: 'string', role: 'indicator', read: true, write: false}
            })
        }

        // ChargeState
        this.setObjectNotExists('chargeState.charging_state', {
            type: 'state',
            common: {name: 'charging_state', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.battery_level', {
            type: 'state',
            common: {name: 'battery_level', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.battery_range', {
            type: 'state',
            common: {name: 'battery_range', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.est_battery_range', {
            type: 'state',
            common: {name: 'est_battery_range', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.ideal_battery_range', {
            type: 'state',
            common: {name: 'ideal_battery_range', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.charge_limit_soc', {
            type: 'state',
            common: {name: 'charge_limit_soc', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.charge_port_door_open', {
            type: 'state',
            common: {name: 'charge_port_door_open', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.scheduled_charging_start_time', {
            type: 'state',
            common: {name: 'scheduled_charging_start_time', type: 'string', role: 'indicator', read: true, write: false}
        })
        this.setObjectNotExists('chargeState.battery_heater_on', {
            type: 'state',
            common: {name: 'battery_heater_on', type: 'string', role: 'indicator', read: true, write: false}
        })

        if(EXTENDED_STATES){
            this.setObjectNotExists('chargeState.fast_charger_present', {
                type: 'state',
                common: {name: 'fast_charger_present', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('chargeState.usable_battery_level', {
                type: 'state',
                common: {name: 'usable_battery_level', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('chargeState.charge_energy_added', {
                type: 'state',
                common: {name: 'charge_energy_added', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('chargeState.charge_miles_added_rated', {
                type: 'state',
                common: {name: 'charge_miles_added_rated', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('chargeState.charger_voltage', {
                type: 'state',
                common: {name: 'charger_voltage', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('chargeState.charger_power', {
                type: 'state',
                common: {name: 'charger_power', type: 'string', role: 'indicator', read: true, write: false}
            })
            this.setObjectNotExists('chargeState.charge_current_request', {
                type: 'state',
                common: {name: 'charge_current_request', type: 'string', role: 'indicator', read: true, write: false}
            })
        }
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Template(options);
} else {
    // otherwise start the instance directly
    new TeslaMotors();
}