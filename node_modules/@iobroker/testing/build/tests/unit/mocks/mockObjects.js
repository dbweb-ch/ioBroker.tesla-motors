"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable @typescript-eslint/camelcase */
const objects_1 = require("alcalzone-shared/objects");
const sinon_1 = require("sinon");
const tools_1 = require("./tools");
// Define here which methods were implemented manually, so we can hook them up with a real stub
// The value describes if and how the async version of the callback is constructed
const implementedMethods = {
    getObjectView: "normal",
    getObjectList: "normal",
};
/**
 * Creates an adapter mock that is connected to a given database mock
 */
function createObjectsMock(db) {
    const ret = {
        getObjectView: ((design, search, { startkey, endkey }, callback) => {
            if (design !== "system")
                throw new Error("If you want to use a custom design for getObjectView, you need to mock it yourself!");
            if (typeof callback === "function") {
                let objects = objects_1.values(db.getObjects("*"));
                objects = objects.filter(obj => obj.type === search);
                if (startkey)
                    objects = objects.filter(obj => obj._id >= startkey);
                if (endkey)
                    objects = objects.filter(obj => obj._id <= endkey);
                callback(null, {
                    rows: objects.map(obj => ({ id: obj._id, value: obj })),
                });
            }
        }),
        getObjectList: (({ startkey, endkey, include_docs, }, callback) => {
            if (typeof callback === "function") {
                let objects = objects_1.values(db.getObjects("*"));
                if (startkey)
                    objects = objects.filter(obj => obj._id >= startkey);
                if (endkey)
                    objects = objects.filter(obj => obj._id <= endkey);
                if (!include_docs)
                    objects = objects.filter(obj => !obj._id.startsWith("_"));
                callback(null, {
                    rows: objects.map(obj => ({
                        id: obj._id,
                        value: obj,
                        doc: obj,
                    })),
                });
            }
        }),
        // TODO: Find out which of those methods are used frequently.
        // All that are NOT should be given functionality by the user using method.returns(...) and similar
        getUserGroup: sinon_1.stub(),
        getMimeType: sinon_1.stub(),
        writeFile: sinon_1.stub(),
        readFile: sinon_1.stub(),
        unlink: sinon_1.stub(),
        delFile: sinon_1.stub(),
        readDir: sinon_1.stub(),
        rename: sinon_1.stub(),
        touch: sinon_1.stub(),
        rm: sinon_1.stub(),
        mkDir: sinon_1.stub(),
        chownFile: sinon_1.stub(),
        chmodFile: sinon_1.stub(),
        subscribeConfig: sinon_1.stub(),
        subscribe: sinon_1.stub(),
        unsubscribeConfig: sinon_1.stub(),
        unsubscribe: sinon_1.stub(),
        chownObject: sinon_1.stub(),
        chmodObject: sinon_1.stub(),
        getObject: sinon_1.stub(),
        getConfig: sinon_1.stub(),
        getConfigKeys: sinon_1.stub(),
        getObjects: sinon_1.stub(),
        getConfigs: sinon_1.stub(),
        setObject: sinon_1.stub(),
        setConfig: sinon_1.stub(),
        delObject: sinon_1.stub(),
        delConfig: sinon_1.stub(),
        extendObject: sinon_1.stub(),
        findObject: sinon_1.stub(),
        destroy: sinon_1.stub(),
        // Mock-specific methods
        resetMockHistory() {
            // reset Objects
            tools_1.doResetHistory(ret);
        },
        resetMockBehavior() {
            // reset Objects
            tools_1.doResetBehavior(ret, implementedMethods);
        },
        resetMock() {
            ret.resetMockHistory();
            ret.resetMockBehavior();
        },
    };
    tools_1.stubAndPromisifyImplementedMethods(ret, implementedMethods, [
        "getObjectView",
        "getObjectList",
    ]);
    return ret;
}
exports.createObjectsMock = createObjectsMock;
