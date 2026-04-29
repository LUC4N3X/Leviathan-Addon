'use strict';

const { EventEmitter } = require('events');

function createInvalidationBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  return {
    on(eventName, listener) {
      emitter.on(eventName, listener);
      return () => emitter.off(eventName, listener);
    },
    emit(eventName, payload) {
      emitter.emit(eventName, payload);
    }
  };
}

module.exports = { createInvalidationBus };
