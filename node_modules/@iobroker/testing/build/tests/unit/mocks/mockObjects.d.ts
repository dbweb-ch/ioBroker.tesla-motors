/// <reference types="iobroker" />
import { MockDatabase } from "./mockDatabase";
import { Mock } from "./tools";
export declare type MockObjects = Mock<ioBroker.Objects> & {
    resetMock(): void;
    resetMockHistory(): void;
    resetMockBehavior(): void;
};
/**
 * Creates an adapter mock that is connected to a given database mock
 */
export declare function createObjectsMock(db: MockDatabase): MockObjects;
