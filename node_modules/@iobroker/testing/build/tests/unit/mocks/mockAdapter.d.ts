/// <reference types="iobroker" />
import { MockDatabase } from "./mockDatabase";
import { MockLogger } from "./mockLogger";
import { MockObjects } from "./mockObjects";
import { Mock } from "./tools";
export declare type MockAdapter = Mock<ioBroker.Adapter> & {
    readyHandler: ioBroker.ReadyHandler | undefined;
    objectChangeHandler: ioBroker.ObjectChangeHandler | undefined;
    stateChangeHandler: ioBroker.StateChangeHandler | undefined;
    messageHandler: ioBroker.MessageHandler | undefined;
    unloadHandler: ioBroker.UnloadHandler | undefined;
    log: MockLogger;
    objects: MockObjects;
    resetMock(): void;
    resetMockHistory(): void;
    resetMockBehavior(): void;
};
/**
 * Creates an adapter mock that is connected to a given database mock
 */
export declare function createAdapterMock(this: MockAdapter | void, db: MockDatabase, options?: Partial<ioBroker.AdapterOptions>): MockAdapter;
