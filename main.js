'use strict';

const utils = require('@iobroker/adapter-core');
const tjs = require('teslajs');

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
        // this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        const Adapater = this;
        this.log.info('Starting Tesla Motors');
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
        const authToken = await this.getStateAsync('authToken');
        const tokenExpire = await this.getStateAsync('tokenExpire');
        var Expires = new Date(tokenExpire.val);
        Expires.setDate(Expires.getDate() - 10);

        if(authToken.val.length == 0 || Expires < new Date()){
            this.GetNewToken(Adapter);
        }
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
        Adapater.log.info('Try to get a new token');
        tjs.login(Adapater.config.teslaUsername, Adapater.config.teslaPassword, function(err, result) {
            if(result.error || !result.authToken){
                Adapater.log.error('Could not get token, stopping Adapter. error: ' + JSON.stringify(result.error));
                this.setForeignState("system.adapter." + this.namespace + ".alive", false);
                return;
            }
            Adapater.log.info('Recieved a new Token');
            Adapater.setState('authToken', result.authToken);
            Adapater.setState('refreshToken', result.refreshToken);
            var ExpireDate = new Date();
            ExpireDate.setSeconds(ExpireDate.getSeconds() + result.body.expires_in);
            Adapater.setState('tokenExpire', ExpireDate);
            Adapater.setState('info.connection', true, true);
        });
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