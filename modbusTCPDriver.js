'use strict'

//*****************************************************************
// This module implements features of your driver, such as
// read|write tags, getting state of activity.
// In this example, we implement Modbus TCP driver,
// you can change all methods for your own driver needs
//*****************************************************************



const net = require("net");

// Error text constants

const errDeviceIdNotFoundTxt    = 'Device ID not found';
const errTagNotFoundTxt         = 'Tag not found';
const errTagNotWriteableTxt     = 'Tag not writeable';
const errConfigTxt              = 'Config error';
const errHostCloseConnectTxt    = 'Host close connection';
const errHostUnreachableTxt     = 'Host unreachable';
const errInvalidSetValueTxt     = 'Invalid set value';
const errInvalidModbusType      = 'Invalid modbus type';
const errClientUndefined        = 'Client undefined';

// Modbus constants

const modbusTypes               = ["Coil", "DescreateInput", "HoldingRegister", "InputRegister"];
const modbusErrorCodes          = {0x01: 'Illegal function',
                                   0x02: 'Illegal data address',
                                   0x03: 'Illegal data value',
                                   0x04: 'Server device failure',
                                   0x05: 'Acknowledge',
                                   0x06: 'Server device busy',
                                   0x08: 'Memory parity error',
                                   0x0A: 'Gateway path unavailable',
                                   0x0B: 'Gateway target device failed to respond'
                                  }
const modbusCmdCodes            = [0x01, 0x02, 0x03, 0x04];
const modbusWriteSingleCoil     = 0x05;
const modbusWriteSingleHold     = 0x06;
const modbusWriteMultiCoil      = 0x0F;
const modbusWriteMultiHold      = 0x10;

// type constants

const typesLength               = {};
typesLength['Int']              = 1;
typesLength['UInt']             = 1;
typesLength['Long']             = 2;
typesLength['ULong']            = 2;
typesLength['Float']            = 2;
typesLength['Double']           = 4;

// default parameters constants

const defaultTimeout            = 10000;
const subscribeTimerCycle       = 1000;
const defaultModbusDisplayType  = 'UInt';
const defaultModbusBytesOrder   = 'BE';
const defaultStringLength       = 0;
const defaultStringEncoding     = 'Win1251';

// class implements Modbus TCP driver
class CustomDriver{
  /**
   *  Class constructor
   *  @param {object} deviceList - list of devices and nodes
   *  @param {method} subscribeHandler - handler calling then subscribed value changes
   *  @param {method} getConfigHandler - handler for reading driver config
   *  @param {method} setConfigHandler - handler for writing driver config
   */
  constructor(deviceList, subscribeHandler, getConfigHandler, setConfigHandler){
    this.deviceList = deviceList;
    this.nodeList = {};
    this.nodeList.list = deviceList.nodes;
    this.connections = {};
    this.clients = {};
    this.requestCounter = 0;
    this.subscribeHandler = subscribeHandler;
    this.getConfigHandler = getConfigHandler;
    this.setConfigHandler = setConfigHandler;
    this.updateSubscribe();
    setInterval(this.subscribeTimer.bind(this), subscribeTimerCycle);
  }

  getDeviceStatus(dataObj){
    let device = this.deviceList.list ? this.deviceList.list[dataObj.uid] : null;
    if(!device) return {active: false};
    dataObj.deviceUid = dataObj.uid;
    let firstTag = Object.keys(device.tags)[0];
    dataObj.tags = [firstTag];
    let fullDeviceName = this.getFullDeviceAddress(dataObj.uid);
    if (!this.connections[fullDeviceName]){
      this.getTagsList('read', dataObj)
      .then(tags => this.createConnect(tags))
      .catch(err => {});
      return {active: false};
    }
    return {active: this.connections[fullDeviceName].connected};
  }

  /**
   * getTagsValues - implements tags values getter
   * @param {object} dataObj - object contains tags for getting value
   *        dataObj.cmd = getTagsValues
   *        dataObj.deviceUid = device Id
   *        dataObj.tags = array of tag names
   * @returns {Promise} Promise with result of tag getting request
   *          if resolve it returns object:
   *            res.answer.cmd = getTagsValues
   *            res.answer.transID = transaction ID (equal to request)
   *            res.answer.values = array with tag values (request order)
   *            res.answer.err = ""
   *          if reject it returns object
   *            res.answer.err = error message
   */ 
  getTagsValues(dataObj){
    return new Promise((resolve, reject) => {
      let res = {};
      res.answer = {cmd:dataObj.cmd, transID: dataObj.transID};
      this.getTagsList('read', dataObj)
      .then(tags => this.modbusReadRequest(tags, dataObj.transID))
      .then(values => {
        res.answer.values = values;
        res.error = "";
        resolve(res);
      })
      .catch(err => {
        res.error = err;
        reject(res);
      })
  	})
  }

  /**
   * setTagsValues - implements tags values setter
   * @param {object} dataObj - object contains tags for setting value
   *                           dataObj.cmd = setTagsValues
   *                           dataObj.deviceUid = device Id
   *                           dataObj.tags = array of objects {tagName : setValue} 
   * @returns {Promise} Promise with result of tag setting request
   *                    if resolve it returns object:
   *                    res.answer.cmd = setTagsValues
   *                    res.answer.transID = transaction ID (equal to request)
   *                    res.answer.err = ""
   *                    if reject it returns object
   *                    res.answer.err = error message
   */
  setTagsValues(dataObj){
    return new Promise((resolve, reject) => {
      let res = {};
      res.answer = {cmd:dataObj.cmd, transID: dataObj.transID};
      let multiWriteEnable = this.isMultiWriteEnable(dataObj);
      this.getTagsList('write', dataObj)
      .then(tags => this.modbusWriteRequest(tags, dataObj.transID, multiWriteEnable))
      .then( _ => {
        res.error = "";
        resolve(res);
      })
      .catch(err => {
        res.error = err;
        reject(res);
      })
    })
  }

  /**
   * setSubscribedValues - method checks if subscribed tags change its values, involve subscribeHandler on true
   * @param {object} dataObj - object contains tags for getting value
   * @param {object} res - result of getTagValues function with current values of tags
   */
  setSubscribedValues(dataObj, res){
    let resIndex = 0;
    let sendSubscribedObj = {};
    sendSubscribedObj.deviceUid = dataObj.deviceUid;
    sendSubscribedObj.values = {};
    for(let tag of dataObj.tags){
      let index = dataObj.deviceUid + ':' + tag;
      if(this.subscribed[index]){
        this.subscribed[index].isRequested = false;
        let newValue = !res.error && res.answer && res.answer.values && (res.answer.values[resIndex] !== undefined) ? res.answer.values[resIndex] : null;
        if(this.subscribed[index].value !== newValue){
          this.subscribed[index].value = sendSubscribedObj.values[tag] = newValue;
        }
      }
      resIndex++;
    }
    if(Object.keys(sendSubscribedObj.values).length) this.subscribeHandler(sendSubscribedObj);
  }

  /**
   * updateTagListFromDevice - this method must be implements if driver can abserve tags
   * @param {object} dataObj - object contains device for tags update
   * @returns {boolean} true if config has updated, otherwize false
   */
  updateTagListFromDevice(dataObj){
    /*let config = this.getConfigHandler();
    ***Update config here***
    this.setConfigHandler(config);*/
    return false;
  }

  /**
   * updateSubscribe - method update this.subscribed object based on this.deviceList.list object
   */
  updateSubscribe(){
    this.subscribed = {};
    for(let item in this.deviceList.list){
      let tags = this.deviceList.list[item].tags;
      if(tags){
        for (let tag in tags){
          if(tags[tag].subscribed) this.subscribed[item + ':' + tag] = {tagname: tag, device: item, value: undefined, isRequested: false};
        }
      }
    }
  }

  /**
   * subscribeTimer - timer method for cycling request of subscribed tags
   */
  subscribeTimer(){
    if(!this.subscribed) return;
    let requestSubscribedObj = {};
    for(let index in this.subscribed){
      let item = this.subscribed[index];
      if(!item.isRequested){
        if(requestSubscribedObj[item.device] === undefined){
          requestSubscribedObj[item.device] = [];
        }
        requestSubscribedObj[item.device].push(item);
        item.isRequested = true;
      }
    }
    this.requestSubscribed(requestSubscribedObj);
  }

  /**
   * requestSubscribed - method creates dataObj variable and handles getTagsValue promise for subscribed tags
   * @param {object} requestSubscribedObj - contains items with subscribed tags information
   */
  requestSubscribed(requestSubscribedObj){
    let dataObj = {cmd: 'getTagsValues', transID: 0};
    for(let item in requestSubscribedObj){
      let tags = [];
      dataObj.deviceUid = item;
      for(let tag in requestSubscribedObj[item]){
        tags.push(requestSubscribedObj[item][tag].tagname);
      }
      if(tags){
        dataObj.tags = tags;
        this.getTagsValues(dataObj)
        .then(res => this.setSubscribedValues(dataObj, res), res => this.setSubscribedValues(dataObj, res)); 
      }
    }
  }

  /**
   * isMultiWriteEnable - function checks if modbus device supports multitag write mode (15/16 modbus functions)
   * @param {object} dataObj - tags object
   * @returns {boolean}
   */
  isMultiWriteEnable(dataObj){
    let res = false;
    let device = this.deviceList.list ? this.deviceList.list[dataObj.deviceUid] : null;
    if (device && device.options && device.options.multiWriteEnable && device.options.multiWriteEnable.currentValue) res = true;
    return res;
  }

  /**
   * getTagsList - function returns array of tags objects with all necessary options for read or write tags values
   * @param {string} cmd - read|write
   * @param {object} dataObj - tags object
   * @returns {Promise} array of tags objects with options on success, error text on fail
   */
  getTagsList(cmd, dataObj){
    return new Promise((resolve, reject) => {
      let device = this.deviceList.list  ? this.deviceList.list[dataObj.deviceUid] : null;
      if(!device){
        reject(errDeviceIdNotFoundTxt);
        return;
      }
      let tags = [];
      for(let item of dataObj.tags){
        let tag = null;
        let tagName = null;
        let tagItem = {};
        tagItem.requestName = item;

        if(cmd == 'read') tag = device.tags ? device.tags[item] : null;
        if(cmd == 'write'){
          tagName = Object.keys(item)[0];
          if(tagName !== null) tag = device.tags ? device.tags[tagName] : null;
        }
        if(!tag){
          tagItem.err = errTagNotFoundTxt;
        }else{
          if((cmd == 'write')  && !tag.write){
            tagItem.err = errTagNotWriteableTxt;
          }
          if ((cmd == 'write') &&
              ((tag.options.modbusVarType.currentValue == 'DiscreteInput') ||
              (tag.options.modbusVarType.currentValue == 'InputRegister'))){
            tagItem.err = errTagNotWriteableTxt;
          }
        }

        
        try{
          tagItem.modbusVarAddress = tag.options.modbusVarAddress.currentValue;
          tagItem.modbusVarType = tag.options.modbusVarType.currentValue;
          tagItem.modbusId = device.options.modbusId.currentValue;
          tagItem.timeout = device.options.timeout.currentValue;
          tagItem.modbusDisplayType = tag.options.modbusDisplayType && tag.options.modbusDisplayType.currentValue ?
                                      tag.options.modbusDisplayType.currentValue : defaultModbusDisplayType;
          tagItem.modbusBytesOrder  = tag.options.modbusBytesOrder && tag.options.modbusBytesOrder.currentValue ?
                                      tag.options.modbusBytesOrder.currentValue : defaultModbusBytesOrder;
          tagItem.stringLength = tag.options.stringLength && tag.options.stringLength.currentValue ?
                                      tag.options.stringLength.currentValue : defaultStringLength;
          tagItem.stringEncoding = tag.options.stringEncoding && tag.options.stringEncoding.currentValue ?
                                      tag.options.stringEncoding.currentValue : defaultStringEncoding;
          tagItem.ip = this.nodeList.list[device.nodeUid].options.modbusHost.currentValue;
          tagItem.port = this.nodeList.list[device.nodeUid].options.modbusPort.currentValue;
          tagItem.deviceUid = dataObj.deviceUid;
          tagItem.varType = tag.type;
          if(cmd == 'read'){
            tagItem.name = item;
            tagItem.read = tag.read;
          }
          if(cmd == 'write'){
            tagItem.name = tagName;
            tagItem.setValue = item[tagName];
          }
        }catch(e){
          if (!tagItem.err) tagItem.err = errConfigTxt;
        }
        tags.push(tagItem);
      }
      resolve(tags);
    });
  }

  /**
   * modbusReadRequest - uplevel method for read request prepare, filling modbus buffer, send requests and handling result
   * @param {object} tags - tags objects array with options for requests
   * @param {int} transID - id transaction getting from server
   * @returns {Promise} array of values on success, error text on fail
   */
  modbusReadRequest(tags, transID){
    return new Promise((resolve,reject) => {
      try{
        let requests = this.prepareRequests('read', tags);
        let buffer = this.prepareBuffer('read', requests, tags);
        this.sendBufferToSocket('read', buffer, tags, requests, transID)
        .then(values => resolve(values))
        .catch(err => {
          console.log(err);
          reject(err);
        })
        .finally( _ => {
          let fullDeviceName = this.getFullDeviceAddress(tags);
          if (fullDeviceName && this.clients[fullDeviceName]) delete this.clients[fullDeviceName][transID];
        });
      }catch(err){
        reject(err.message);
      }
    })
  }

  /**
   * modbusWriteRequest - uplevel method for write request prepare, filling modbus buffer, send requests and handling result
   * @param {object} tags - tags objects array with options for requests
   * @param {int} transID - id transaction getting from server
   * @param {boolean} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {Promise} undefined on success, text error on fail
   */
  modbusWriteRequest(tags, transID, multiWriteEnable){
    return new Promise((resolve, reject) => {
      try{
        let requests = this.prepareRequests('write', tags, multiWriteEnable);
        let buffer = this.prepareBuffer('write', requests, tags, multiWriteEnable);
        this.sendBufferToSocket('write', buffer, tags, requests, transID)
        .then( _ => resolve())
        .catch(err => {
          console.log(err);
          reject(err);
        })
        .finally( _ => {
          let fullDeviceName = this.getFullDeviceAddress(tags);
          delete this.clients[fullDeviceName][transID];
        });
      }catch(err){
        reject(err.message);
      }
    })
  }

  /**
   * sendBufferToSocket - function creates promise chain with checks of modbus slave: 
   * we have connect for device, device is inline, device is not busy.
   * Next step: send buffer data to socket, wait for answer and handling parseResult function
   * Also function creates this.clients object for futher parsing of answers
   * @param {string} cmd - read|write
   * @param {array of Buffer} buffer - array of raw data for sending to slave modbus device
   * @param {object} tags - tags objects array with options for requests
   * @param {array of objects} requests - contains requests[modbusType] objects depand on tags objects array
   * @param {int} transID - id transaction getting from server
   * @returns 
   */
  sendBufferToSocket(cmd, buffer, tags, requests, transID){
    let chain = Promise.resolve();
    if(!buffer) return chain;
    let fullDeviceName = this.getFullDeviceAddress(tags);
    if (!this.clients[fullDeviceName]) this.clients[fullDeviceName] = {};
    this.clients[fullDeviceName][transID] = {};
    this.clients[fullDeviceName][transID].values = {};
    if (!this.connections[fullDeviceName]){
      chain = chain.then( _ => this.createConnect(tags));
    }
    buffer.forEach((item) => {
      chain = chain.then( _ => this.checkConnected(fullDeviceName, tags));
      chain = chain.then( _ => this.checkSocketReady(fullDeviceName, tags));
      chain = chain.then( _ => this.sendToSocket(item, this.connections[fullDeviceName]));
      chain = chain.then( _ => this.waitAnswer(item, this.connections[fullDeviceName], tags));
      chain = chain.then( result => this.parseResult(cmd, result, tags, requests, transID));
    });
    chain = chain.then( _ => this.finishParse(cmd, tags, transID));
    return chain;
  }

  /**
   * addResolveQueue - method creates array for client devices (if not exists)
   * and push it handler for resolve method, which will involve then device will
   * became online or not busy
   * @param {object} client - contains information about slave modbus device connection
   * @param {method} resolve - handler for resolve method
   * @param {string} type - waitConnectResolves|nextRequestResolves: 
   * waitConnectResolves type for not connected device
   * nextRequestResolves type for busy devices
   */
  addResolveQueue(client, resolve, type){
    if(!client[type]) client[type] = [];
    client[type].push(resolve);
  }

  /**
   * checkConnected - checks if slave modbus device is connected
   * @param {string} fullDeviceName - device name in format host:port or ip:port
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} - resolve on connected, else add resolve to queue, reject on timeout event
   */
  checkConnected(fullDeviceName, tags){
    return new Promise((resolve) => {
      let client = this.connections[fullDeviceName];
      if(client.connected){
        resolve();
        return;
      }else{
        this.addResolveQueue(client, resolve, 'waitConnectResolves');
      }
      let timeout = this.getTimeout(tags) || defaultTimeout;
      setTimeout( _ => resolve(), timeout);
    })
  }

  /**
   * checkSocketReady - checks if slave modbus device is ready for trasaction
   * @param {string} fullDeviceName - device name in format host:port or ip:port
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} - resolve on device not busy, else add resolve to queue, alarm reject on timeout
   */
  checkSocketReady(fullDeviceName, tags){
    return new Promise((resolve, reject) => {
      let client = this.connections[fullDeviceName];
      if(!client){
        reject(errHostUnreachableTxt);
        return;
      }
      if(!client.waitresponse){
        client.waitresponse = {};
        resolve();
        return;
      }else{
        this.addResolveQueue(client, resolve, 'nextRequestResolves');
      }
      let timeout = this.getTimeout(tags) || defaultTimeout;
      setTimeout( _ => resolve(), timeout);
    })
  }

  /**
   * createConnect - creates net socket for modbus slave device, involve resolve handlers for clients waiting for connect,
   * initializes methods for events on.data, on.close, on.error
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise} resolve on success connect, reject on connect error
   */
  createConnect(tags){
    return new Promise((resolve, reject) => {
      let client = new net.Socket();
      let fullDeviceName = this.getFullDeviceAddress(tags);
      this.connections[fullDeviceName] = client;
      client.connected = false;
      client.fullDeviceAddress = fullDeviceName;
      client.connect(this.getPort(tags), this.getHost(tags), _ => {
        client.connected = true;
        resolve(client);
        if(client.waitConnectResolves){
          for(let resolve of client.waitConnectResolves){
            setTimeout( _ => resolve() , 0);
          }
          client.waitConnectResolves = null;
        }
      });
      client.on("data", data => {
        this.response(client, data);
      });
      client.on("close", _ => {
        delete this.connections[client.fullDeviceAddress];
        client.connected = false;
        let errTxt = `${errHostCloseConnectTxt} ${fullDeviceName}`;
        reject(errTxt);
      });
      client.on("error", data => {
        delete this.connections[client.fullDeviceAddress];
        client.connected = false;
        let errTxt = `${errHostUnreachableTxt}  ${fullDeviceName}`;
        reject(errTxt);
      });
    });
  }

  /**
   * sendToSocket - method send request buffer to modbus slave device
   * @param {Buffer} request - raw data array 
   * @param {object} client - socket object
   */
  sendToSocket(request, client){
    try{
      if(!client){
        throw new Error(errClientUndefined);
      }
      client.write(request);
    }
    catch(err){
      console.log(err.message);
    }
  }

  
  /**
   * response - handler method for incoming packets from slave devices
   * @param {object} client - socket object 
   * @param {Buffer} data - raw data array
   */
  response(client, data){
    let responsePacket = new Packet(data);
    if(client.waitresponse && client.waitresponse.requestId     ==   responsePacket.getId()
                           && client.waitresponse.modbusAddress ==   responsePacket.getModbusAddress()
                           && client.waitresponse.modbusFunc    ==   responsePacket.getModbusFunc()){
      if (responsePacket.getModbusErrorStatus()){
        let errCode = responsePacket.getModbusErrorCode(); 
        let errTxt = (errCode && modbusErrorCodes[errCode]) ? modbusErrorCodes[errCode] : 'Unknowng Modbus Error';
        client.waitresponse.reject(errTxt);
      }else{
        client.waitresponse.resolve(data);
      }
      if(client.nextRequestResolves){
        let resolve = client.nextRequestResolves.shift();
        if(resolve) resolve();
      }
      client.waitresponse = null;
    }
  }

  /**
   * parseResult - method parses incoming packet, checks packetId and calls valueAssign method
   * @param {string} cmd - read|write
   * @param {Buffer} data - raw data array
   * @param {object} tags - tags objects array with options for requests
   * @param {array of objects} requests - contains requests[modbusType] objects depand on tags objects array 
   * @param {int} transID - id transaction getting from server
   */
  parseResult(cmd, data, tags, requests, transID){
    if(cmd == 'read'){
      let responsePacket = new Packet(data);
      let valuesData = responsePacket.getValues();
      let packetId = responsePacket.getId();
      for (let request of requests){
        for(let item of request){
          if(item.requestCounter == packetId){
            this.valuesAssign(item, tags, valuesData, transID);
            break;
          }
        }
      }
    }
  }

  /**
   * waitAnswer - returns Promise: resolve handle put into client.waitresponse object and calls on response, reject calls on timeout event
   * @param {Buffer} request - raw data array
   * @param {object} client - socket object 
   * @param {object} tags - tags objects array with options for requests
   * @returns {Promise}
   */
  waitAnswer(request, client, tags){
    return new Promise((resolve, reject) => {
      let requestPacket = new Packet(request);
      client.waitresponse = {resolve: resolve, reject: reject, requestId: requestPacket.getId(), modbusAddress: requestPacket.getModbusAddress(), modbusFunc: requestPacket.getModbusFunc()};
      let timeout = this.getTimeout(tags) || defaultTimeout;
      setTimeout( _ => resolve(null), timeout);
    });
  }

  /**
   * prepareBuffer - creates raw data buffers depand on requests
   * @param {string} cmd - read|write 
   * @param {array of objects} requests - contains requests[modbusType] objects depand on tags objects array 
   * @param {object} tags - tags objects array with options for requests
   * @param {boolean} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {array of Buffer} - array raw data buffers depand on requests
   */
  prepareBuffer(cmd, requests, tags, multiWriteEnable = true){
    let buffers = [];
    let modbusDeviceId = this.getModbusDeviceId(tags);
    if(!modbusDeviceId) return null;
    for (let i = 0; i < modbusCmdCodes.length; i++){
      if(requests[i]){
        for (let item of requests[i]){
          let buffArr = [];
          if(cmd == 'read') buffArr = this.getReadBuffArr(item, modbusDeviceId, modbusCmdCodes[i]);
          if(cmd == 'write') buffArr = this.getWriteBuffArr(item, modbusDeviceId, modbusTypes[i], multiWriteEnable);
          buffers.push(Buffer.from(buffArr));
        }
      }
    }
    return buffers;
  }

  /**
   * getReadBuffArr - creates buffer for read request
   * @param {object} item - object with data requests
   * @param {int} modbusDeviceId - modbus device id
   * @param {int} modbusCode - modbus function code
   * @returns {array} - data array for request
   */
  getReadBuffArr(item, modbusDeviceId, modbusCode){
    const modbusProtocolId = 0;
    const packetLength = 6;
    let buffArr = [];
    let requestCounter = this.getRequestCounter();
    item.requestCounter = requestCounter;
    this.addWord(buffArr, requestCounter);
    this.addWord(buffArr, modbusProtocolId);
    this.addWord(buffArr, packetLength);
    buffArr.push(modbusDeviceId);
    buffArr.push(modbusCode);
    this.addWord(buffArr, item.start);
    this.addWord(buffArr, item.count);
    return buffArr;
  }

  /**
   * getWriteBuffArr - creates buffer for write request
   * @param {object} item - object with data requests
   * @param {int} modbusDeviceId - modbus device id
   * @param {string} modbusType - modbus type register
   * @param {boolean} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {array} - data array for request
   */
  getWriteBuffArr(item, modbusDeviceId, modbusType, multiWriteEnable){
    const modbusProtocolId = 0;
    const packetLength = this.getModbusPacketLength(item, modbusType, multiWriteEnable);
    let buffArr = [];
    let requestCounter = this.getRequestCounter();
    item.requestCounter = requestCounter;
    this.addWord(buffArr, requestCounter);
    this.addWord(buffArr, modbusProtocolId);
    this.addWord(buffArr, packetLength);
    buffArr.push(modbusDeviceId);
    buffArr.push(this.getModbusWriteCode(modbusType, multiWriteEnable));
    this.addWord(buffArr, item.start);
    if(multiWriteEnable){
      this.addWord(buffArr, item.count);
      buffArr.push(this.getModbusBytesCountLeft(item, modbusType));
    }
    this.pushSetValues(buffArr, item, modbusType, multiWriteEnable);
    return buffArr;
  }

  /**
   * getModbusPacketLength - calculates modbus packet length for write request
   * @param {object} item - object with data requests
   * @param {string} modbusType - modbus function type name
   * @param {boolean} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {int} - modbus packet length for write request, or error on wrong request
   */
  getModbusPacketLength(item, modbusType, multiWriteEnable){
    if(!multiWriteEnable) return 6;
    if(modbusType == 'Coil'){
      return 7 + this.getModbusBytesCountLeft(item, modbusType);
    }
    if(modbusType == 'HoldingRegister'){
      return 7 + this.getModbusBytesCountLeft(item, modbusType);
    }
    throw new Error('Cannot calc packet length: unsupported write type');
  }

  /**
   * getModbusBytesCountLeft - calculates bytes count for request header
   * @param {object} item - object with data requests
   * @param {string} modbusType - modbus function type name
   * @returns {int}
   */
  getModbusBytesCountLeft(item, modbusType){
    if(modbusType == 'Coil'){
      return Math.ceil(item.count / 8);
    }
    if(modbusType == 'HoldingRegister'){
      return 2 * item.count;
    }
    return null;
  }

  /**
   * pushSetValues - method add set values to data buffer 
   * @param {array} buffArr - raw data array
   * @param {object} item - object with data requests
   * @param {string} modbusType - modbus function type name
   * @param {boolean} multiWriteEnable  - true if multiwrite mode (15/16 modbus functions) enable
   */
  pushSetValues(buffArr, item, modbusType, multiWriteEnable){
    const getLastElemValue = (item, i) => {
      let res = {};
      if(item.tags.length > i){
        let valuesArr = item.tags[i];
        if(valuesArr.length > 0){
          let valuesElem = valuesArr[valuesArr.length - 1];
          res.value1 = valuesElem.value1;
          res.value2 = valuesElem.value2;
        }
      }
      if(!res) throw new Error('Set value index error');
      return res;
    }
    if(!multiWriteEnable){
      let setValue = getLastElemValue(item, 0);
      if(modbusType == 'Coil'){
        if((setValue.value1 + setValue.value2) !== 0){
          buffArr.push(0xFF);
          buffArr.push(0x00);
        }else{
          buffArr.push(0x00);
          buffArr.push(0x00);
        }
      }
      if(modbusType == 'HoldingRegister'){
        buffArr.push(setValue.value1);
        buffArr.push(setValue.value2);
      }
    }else{ // multiWriteEnable = true
      if(modbusType == 'Coil'){
        for(let i = 0; i < this.getModbusBytesCountLeft(item, modbusType); i++){
          let byteValue = 0;
          for(let j = 0; j < 8; j++){
            if(item.tags.length > i + j){
              let setValue = getLastElemValue(item, i + j);
              if((setValue.value1 + setValue.value2) !== 0){
                byteValue += (1 << j);
              }
            }
          }
          buffArr.push(byteValue);
        }
      }
      if(modbusType == 'HoldingRegister'){
        for(let i = 0; i < item.count; i++){
          let setValue = getLastElemValue(item, i);
          buffArr.push(setValue.value1);
          buffArr.push(setValue.value2);
        }
      }
    }
  }

  /**
   * getModbusWriteCode - returns modbus write function
   * @param {string} modbusType - modbus function type name
   * @param {boolean} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {int}
   */
  getModbusWriteCode(modbusType, multiWriteEnable){
    if((modbusType == 'Coil') && !multiWriteEnable) return modbusWriteSingleCoil;
    if((modbusType == 'Coil') && multiWriteEnable) return modbusWriteMultiCoil;
    if((modbusType == 'HoldingRegister') && !multiWriteEnable) return modbusWriteSingleHold;
    if((modbusType == 'HoldingRegister') && multiWriteEnable) return modbusWriteMultiHold;
    throw new Error('Cannot get modbus code: unsupported write type');
  }

  /**
   * addWord - method add to arr two lowest bytes of value
   * @param {array} arr - data array
   * @param {int} value - value to add
   */
  addWord(arr, value){
    arr.push((value & 0xFF00) >> 8);
    arr.push(value & 0xFF);
  }

  /**
   * getRequestCounter - get next modbus request id [1..65535]
   * @returns {int}
   */
  getRequestCounter(){
    if (this.requestCounter > 0xFFFF) this.requestCounter = 0;
    return this.requestCounter++;
  }

  /**
   * getTypeLength - returns length data depend on data type
   * @param {object} item - object with modbus params
   * @returns {int}
   */
  getTypeLength(item){
    if(item.varType == 'string'){
      if(item.stringLength) return Math.ceil(item.stringLength / 2);
      return 1;
    } 
    if ((item.modbusVarType == 'Coil') || (item.modbusVarType == "DescreateInput")) return 1;
    let typeName = item.modbusDisplayType;
    if(!typeName) return 1;
    let len = typesLength[typeName];
    if(len) return len;
    return 1;
  }

  /**
   * prepareRequests - creates requests[modbusType] objects depand on tags objects array
   * Adds index to tag names for futher type parsing (nessesary for tags which length more then one register)
   * @param {string} cmd - read|write 
   * @param {array of objects} tags -tags objects array with options for requests
   * @param {boolean} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {array of objects}
   */
  prepareRequests(cmd, tags, multiWriteEnable = true){
    let requests = [];
    let registers = {};
    modbusTypes.forEach((item) => {
      registers[item] = [];
    });
    for (let item of tags){
      if(item.err) continue;
      if(!registers.hasOwnProperty(item.modbusVarType)){
        item.err = errInvalidModbusType;
        continue;
      }
      if(cmd == 'read' && !item.read) continue;
      let len = this.getTypeLength(item);
      let valueWriteParts = [];
      if(cmd == 'write'){
        if (!this.checkSetValue(item)) throw new Error(errInvalidSetValueTxt);
        valueWriteParts = this.getValueWriteParts(item);
      }
      for(let i = 0; i < len; i++){
        if(cmd == 'read'){
          registers[item.modbusVarType].push({"tag": i.toString() + "_" + item.name, "address": item.modbusVarAddress + i});
        }else{
          registers[item.modbusVarType].push({"tag": i.toString() + "_" + item.name, "address": item.modbusVarAddress + i,
                                              "value1": valueWriteParts[i].d0, "value2": valueWriteParts[i].d1});
        }
      }
    }
    modbusTypes.forEach((item) => {
      requests.push(this.getRequestByType(cmd, registers, item, multiWriteEnable));
    });
    return requests;
  }

  /**
   * getValueWriteParts - gets object array with encoding setting value depand on display type and bytes order
   * @param {object} valueObj - tag object with options for request
   * @returns {array of objects}
   */
  getValueWriteParts(valueObj){
    let res = [];
    valueObj.modbusDisplayType = valueObj.modbusDisplayType || defaultModbusDisplayType;
    valueObj.modbusBytesOrder = valueObj.modbusBytesOrder || defaultModbusBytesOrder;
    let regsCount = this.getTypeLength(valueObj);
    this.encodeValue(valueObj);
    this.swapBytes(valueObj);
    for (let i = 0; i < regsCount; i++) {
      res.push(valueObj[i]);
    }
    return res;
  }

  /**
   * encodeValue - encodes setting value depend on value type
   * @param {object} valueObj - tag object with options for request
   * @returns {object}
   */
  encodeValue(valueObj){
    if(valueObj.varType == 'string') return this.stringEncodeValue(valueObj);
    switch (valueObj.modbusDisplayType) {
      case 'Int': case 'Long': case 'UInt': case 'ULong':
        return this.uniEncodeIntValue(valueObj);
      case 'Float': case 'Double':
        return this.encodeFloatValue(valueObj);
      default:
        return this.uniEncodeIntValue(valueObj);
    }
  }

  /**
   * stringEncodeValue - encodes setting string value
   * @param {object} valueObj - tag object with options for request
   */
  stringEncodeValue(valueObj){
    let value = valueObj.setValue;
    let regsCount = this.getTypeLength(valueObj);
    for(let i = 0; i < regsCount; i++){
      valueObj[i] = {};
      if(2 * i < value.length){
        valueObj[i].d0 = this.getCharCode(value[i * 2], valueObj.stringEncoding);
      }else{
        valueObj[i].d0 = 0;
      }
      if(2 * i + 1 < value.length){
        valueObj[i].d1 = this.getCharCode(value[i * 2 + 1], valueObj.stringEncoding);
      }else{
        valueObj[i].d1 = 0;
      }
    }
  }

  /**
   * getCharCode - returns code of char[0] depand on stringEncoding
   * @param {string} char - char[0] for getting char code
   * @param {string} stringEncoding - CP866|CP855|Win1251
   * @returns {int}
   */
  getCharCode(char, stringEncoding){
    const cp866Table   = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~ АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмноп                                                рстуфхцчшщъыьэюяЁё      °   №";
    const cp855Table   = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~     ёЁ                      юЮъЪаАбБцЦдДеЕфФгГ       хХиИ    йЙ       кК        лЛьЬнНоОп    Пя ЯрРсСтТуУжЖвВьЬ№-ыЫзЗшШэЭщЩчЧ";
    const win1251Table = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~                                                                 АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
    let charTable = "";
    switch(stringEncoding){
      case "CP866":
        charTable = cp866Table;
        break;
      case "CP855": 
        charTable = cp855Table;
        break;
      case "Win1251": 
        charTable = win1251Table;
        break;
      default: charTable = "";
    }
    let idx = charTable.indexOf(char);
    if(idx < 0) return 0;
    return idx + 32;
  }

  /**
   * uniEncodeIntValue - encodes integer values into registers
   * @param {object} valueObj - tag object with options for request
   */
  uniEncodeIntValue(valueObj){
    let value = valueObj.setValue;
    let regsCount = this.getTypeLength(valueObj);
    let maxCapacity = this.getMaxCapacity(regsCount);
    if(value < 0) value += maxCapacity;
    for(let i = 0; i < regsCount; i++){
      let regValue = value >> ((regsCount - i - 1) * 16);
      valueObj[i] = {};
      valueObj[i].d0 = (regValue >> 8) & 0x00FF;
      valueObj[i].d1 = regValue & 0x00FF;
    }
  }

  /**
   * encodeFloatValue - encodes float values into registers
   * @param {object} valueObj - tag object with options for request
   */
  encodeFloatValue(valueObj){
    let value = valueObj.setValue;
    let regsCount = this.getTypeLength(valueObj);
    let buffer = new ArrayBuffer(2 * regsCount + 1);
    let view = new DataView(buffer);
    if(regsCount == 2){
      view.setFloat32(0, value);
    }else if(regsCount == 4){
      view.setFloat64(0, value);
    }else{
      throw new Error('Wrong float value size');
    }
    let int8Buf = new Uint8Array(buffer);
    for(let i = 0; i < regsCount; i++){
      valueObj[i] = {};
      valueObj[i].d0 = int8Buf[2 * i];
      valueObj[i].d1 = int8Buf[2 * i + 1];;
    }
  }

  /**
   * checkSetValue - function validates setting value depend on it type
   * @param {object} valueObj - tag object with options for request
   * @returns {bool}
   */
  checkSetValue(valueObj){
    if(valueObj.varType == 'string') return true;
    let value = valueObj.setValue;
    if(typeof(value) !== 'number') return false;
    if((valueObj.modbusDisplayType == 'Float') || (valueObj.modbusDisplayType == 'Double')) return true;
    let regsCount = this.getTypeLength(valueObj);
    let signed = this.isTypeSigned(valueObj.modbusDisplayType);
    let maxCapacity = this.getMaxCapacity(regsCount);
    if(signed){
      return ((value >= -maxCapacity / 2) && (value <= maxCapacity / 2 - 1));
    }else{
      return ((value >= 0) && (value < maxCapacity));
    }
  }

  /**
   * getRequestByType - returns array of objects with calculate requests options
   * @param {string} cmd - read|write 
   * @param {arra of objects} registers - contains registers[modbusType] objects with modbus parameters
   * @param {string} type - modbus function type name
   * @param {bool} multiWriteEnable - true if multiwrite mode (15/16 modbus functions) enabled
   * @returns {array of objects}
   */
  getRequestByType(cmd, registers, type, multiWriteEnable){
    const getTag = (cmd, item) => {
      if(cmd == 'read') return item.tag;
      if(cmd == 'write') return {'tagName': item.tag, 'value1': item.value1, 'value2': item.value2}
      return null;
    }
    const maxRegReadCount = 125;
    const maxCoilReadCount = 2000;
    let maxReadCount = ((type == "Coil") || (type == "DescreateInput")) ? maxCoilReadCount : maxRegReadCount;
    let requests = [];
    let counter = 0;
    let startIndex = -1;
    let tags = [];
    let requestsTags = [];
    let sortedRegs = this.getSortedRegs(registers[type]);
    for(let item of sortedRegs){
      if(!counter){
        startIndex = item.address;
        tags.push(getTag(cmd, item));
        counter++;
      }else{
        let prevIndex = startIndex + counter - 1;
        if(prevIndex == item.address) tags.push(getTag(cmd, item));
        if(((item.address - prevIndex) == 1) && (counter < maxReadCount) && multiWriteEnable){
          requestsTags.push(tags);
          tags = [getTag(cmd, item)];
          counter++;
        }else if(((item.address - prevIndex) > 1) || (counter == maxReadCount) || !multiWriteEnable){
          requestsTags.push(tags);
          requests.push({"start": startIndex, "count": counter, "tags": requestsTags, "type": type});
          requestsTags = [];
          startIndex = item.address;
          tags = [getTag(cmd, item)];
          counter = 1;
        }
      }
    }
    if(counter){
      requestsTags.push(tags);
      requests.push({"start": startIndex, "count": counter, "tags": requestsTags, "type": type});
    }
    return requests;
  }

  /**
   * getTagsObj - tranforms tags array to object with tagnames as keys
   * @param {array} tags - tags array with options for requests
   * @returns {object}
   */
  getTagsObj(tags){
    let res = {};
    for (let tag of tags){
      if(tag.name) res[tag.name] = tag;
    }
    return res;
  }

  /**
   * valuesAssign - method assigns values from returned data to requested list
   * @param {object} item - object with start and count fields
   * @param {array of arrays} tags - array [0..count - 1] of arrays with tags objects
   * @param {array} data - raw response data 
   * @param {int} transID - id transaction getting from server
   */
  valuesAssign(item, tags, data, transID){
    let fullDeviceName = this.getFullDeviceAddress(tags);
    let tagsObj = this.getTagsObj(tags);
    let buffer = {};
    for(let i = 0; i < item.tags.length; i++){
      let isDescreate = ((item.type == 'Coil') || (item.type == 'DescreateInput'));
      for(let j = 0; j < item.tags[i].length; j++){
        let itemName = this.getItemName(item.tags[i][j]);
        if(isDescreate){
          this.clients[fullDeviceName][transID].values[itemName] = this.parseDiscreateValue(i, data);
        }else{
          if(!buffer[itemName]){
            buffer[itemName] = {};
            let mdt = tagsObj[itemName].modbusDisplayType;
            if(mdt) buffer[itemName].modbusDisplayType = mdt;
            let mbo = tagsObj[itemName].modbusBytesOrder;
            if(mbo) buffer[itemName].modbusBytesOrder = mbo;
            buffer[itemName].modbusVarType = tagsObj[itemName].modbusVarType;
            let vt = tagsObj[itemName].varType;
            if(vt) buffer[itemName].varType = vt;
            let sl = tagsObj[itemName].stringLength;
            if(sl) buffer[itemName].stringLength = sl;
            let se = tagsObj[itemName].stringEncoding;
            if(se) buffer[itemName].stringEncoding = se;
          }
          let tagIndex = this.getItemIndex(item.tags[i][j]);
          buffer[itemName][tagIndex] = {};
          if(data.length > i * 2 + 1){
            buffer[itemName][tagIndex].d0 = data[i * 2];
            buffer[itemName][tagIndex].d1 = data[i * 2 + 1];
          }
        }
      }
    }
    for(let itemName in buffer){
      let parseValue = buffer[itemName].varType == 'string' ? buffer[itemName] : this.parseValue(buffer[itemName]);
      this.clients[fullDeviceName][transID].values[itemName] = this.castType(parseValue, buffer[itemName]);
    };
  }

  /**
   * getItemName - returns tag name
   * @param {string} item - string = "index_tagname"
   * @returns {string}
   */
  getItemName(item){
    let sepIndex = item.indexOf("_");
    if(sepIndex > 0) return item.slice(sepIndex + 1);
    return null;
  }

  /**
   * getItemIndex - returns tag index
   * @param {string} item - string = "index_tagname"
   * @returns {int}
   */
  getItemIndex(item){
    let sepIndex = item.indexOf("_");
    if(sepIndex > 0) return parseInt(item.slice(0, sepIndex));
    return null;
  }

  /**
   * castType - cast value to tag specific type
   * @param {*} value - value data
   * @param {object} item - tag object with options
   * @returns {*}
   */
  castType(value, item){
    let varType = item.varType;
    if (varType == 'string') return this.parseString(value, item.stringLength, item.stringEncoding);
    if (varType == 'bool') return value !== 0;
    return value;
  }

  /**
   * parseString - returns string from buffer depand on stringEncoding
   * @param {array} buffer - data raw
   * @param {int} stringLength - string length
   * @param {string} stringEncoding - CP866|CP855|Win1251
   * @returns {string}
   */
  parseString(buffer, stringLength, stringEncoding){
    let res = '';
    let i = 0;
    let elem = buffer[i];
    while(elem){
      let ch0 = buffer[i].d0;
      let ch1 =  (i * 2 + 1) == stringLength ? 0 : buffer[i].d1;
      if(ch0 == 0) return res;
      res += this.getAsciiChar(ch0, stringEncoding);
      if(ch1 == 0) return res;
      res += this.getAsciiChar(ch1, stringEncoding);
      elem = buffer[++i];
    }
    return res;
  }

  /**
   * getAsciiChar - returns char by code depand on stringEncoding
   * @param {byte} code - char code
   * @param {string} stringEncoding - CP866|CP855|Win1251
   * @returns {string[1]}
   */
  getAsciiChar(code, stringEncoding){
    if(stringEncoding == 'CP866') return this.getCP866Char(code);
    if(stringEncoding == 'CP855') return this.getCP855Char(code);
    if(stringEncoding == 'Win1251') return this.getWin1251Char(code);
    return "";
  }

  /**
   * getCP866Char - returns char by code in CP866 code page
   * @param {*} code - char code
   * @returns {string[1]}
   */
  getCP866Char(code){
    let res = "";
    const cyrillicTable = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяЁё";
    if((code <= 127) || ((code >= 176) && (code <= 223)) || (code >= 242)){
      res = String.fromCharCode(code)
    }
    else if(code < 176){
      res = cyrillicTable[code - 128];
    }else{
      res = cyrillicTable[code - 224 + 48];
    }
    return res;
  }

  /**
   * getCP855Char - returns char by code in CP855 code page
   * @param {*} code - char code
   * @returns {string[1]}
   */
   getCP855Char(code){
    let res = "";
    const cyrillicTable = "    ёЁ                      юЮъЪаАбБцЦдДеЕфФгГ       хХиИ    йЙ       кК        лЛьЬнНоОп    Пя ЯрРсСтТуУжЖвВьЬ№-ыЫзЗшШэЭщЩчЧ   ";
    if(code <= 127)
      res = String.fromCharCode(code);
    else
      res = cyrillicTable[code - 128];
    return res;
  }
  /**
   * getWin1251Char - returns char by code in Win1251 code page
   * @param {*} code - char code
   * @returns {string[1]}
   */
  getWin1251Char(code){
    let res = "";
    const cyrillicTable = "АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя";
    if(code <= 191)
      res = String.fromCharCode(code);
    else
      res = cyrillicTable[code - 192];
    return res;
  }

  /**
   * parseValue - parses numberic values from data raw
   * @param {object} valueObj - tag object with tag params and raw array data value
   * @returns {numberic}
   */
  parseValue(valueObj){
    this.swapBytes(valueObj);
    let signed = this.isTypeSigned(valueObj.modbusDisplayType);
    switch (valueObj.modbusDisplayType) {
      case 'Int': case 'Long':
        return this.uniParseIntValue(valueObj, signed);
      case 'UInt': case 'ULong':
        return this.uniParseIntValue(valueObj, signed);
      case 'Float':
        return this.parseFloatValue(valueObj, false);
      case 'Double':
        return this.parseFloatValue(valueObj, true);
      default:
        return this.uniParseIntValue(valueObj, signed);
    }
  }

  /**
   * isTypeSigned - checks if display type is signed
   * @param {string} mdt - modbus display type 
   * @returns {bool}
   */
  isTypeSigned(mdt){
    if ((mdt == 'UInt') || (mdt == 'ULong')) return false;
    return true;
  }

  /**
   * getBytesArr - returns array with data raw
   * @param {object} valueObj - tag object with current raw values
   * @returns {array of byte}
   */
  getBytesArr(valueObj){
    let regsCount = this.getTypeLength(valueObj);
    let bytesArr = [];
    for(let i = 0; i < regsCount; i++){
      bytesArr.push(valueObj[i].d0);
      bytesArr.push(valueObj[i].d1);
    }
    return bytesArr;
  }

  /**
   * swapBytes - method replace bytes in valueObj depend on modbusBytesOrder field
   * @param {object} valueObj - tag object with current raw values
   */
  swapBytes(valueObj){
    if(valueObj.modbusBytesOrder == 'BE') return;
    let regsCount = this.getTypeLength(valueObj);
    let bytesArr = this.getBytesArr(valueObj);
    if(valueObj.modbusBytesOrder.includes('LE')){
      for(let i = 0; i < regsCount; i++){
        let tmp = bytesArr[i];
        bytesArr[i] = bytesArr[regsCount * 2 - i - 1];
        bytesArr[regsCount * 2 - i - 1] = tmp;
      }
    }
    if(valueObj.modbusBytesOrder.includes('S')){
      for(let i = 0; i < regsCount; i++){
        let tmp = bytesArr[2 * i];
        bytesArr[2 * i] = bytesArr[2 * i + 1];
        bytesArr[2 * i + 1] = tmp;
      }
    }
    for(let i = 0; i < regsCount; i++){
      valueObj[i].d0 = bytesArr[2 * i];
      valueObj[i].d1 = bytesArr[2 * i + 1];
    }
  }

  /**
   * uniParseIntValue - parses integer values
   * @param {object} valueObj - tag object with current raw values
   * @param {boolean} signed - true if value signed 
   * @returns {int}
   */
  uniParseIntValue(valueObj, signed){
    let regsCount = this.getTypeLength(valueObj);
    if(!this.checkValueInfo(valueObj, regsCount)) return null;
    let bytesArr = this.getBytesArr(valueObj);
    let value = 0;
    for(let i = 0; i < 2 * regsCount; i++){
      let coef = BigInt(1);
      coef <<= BigInt((2 * regsCount - i - 1) * 8);
      coef = Number(coef);
      value += coef * bytesArr[i];
    }
    if(!signed) return value;
    let maxCapacity = this.getMaxCapacity(regsCount);
    return (value >= maxCapacity / 2) ? value - maxCapacity : value;
  }

  /**
   * getMaxCapacity - returns max number, capacity in <regsCount> modbus registers
   * @param {int} regsCount - number of modbus registers
   * @returns {number}
   */
  getMaxCapacity(regsCount){
    let maxCapacity = BigInt(1);
    maxCapacity <<= BigInt(16 * regsCount);
    maxCapacity = Number(maxCapacity);
    return maxCapacity;
  }

  /**
   * parseFloatValue - parses float values
   * @param {object} valueObj - tag object with current raw values
   * @param {boolean} double - precision flag: if true returns double(64bit) float
   * @returns {float}
   */
  parseFloatValue(valueObj, double){
    let bytesArr = this.getBytesArr(valueObj);
    let aBuf = new ArrayBuffer(bytesArr.length);
    let view = new DataView(aBuf);
    bytesArr.forEach(function (b, i) {
      view.setUint8(i, b);
    });
    let res = double ? view.getFloat64(0) : view.getFloat32(0);
    return res;
  }

  /**
   * checkValueInfo - checks if valueObj contains valid data values
   * @param {object} valueObj - tag object with current raw values
   * @param {int} regsCount - number of registers
   * @returns {bool}
   */
  checkValueInfo(valueObj, regsCount){
    for(let i = 0; i < regsCount; i++){
      if(!valueObj[i]) return false;
      if(valueObj[i].d0 === undefined || valueObj[i].d1 === undefined) return false;
    }
    return true;
  }

  /**
   * parseDiscreateValue - returns state of i bit index in data array
   * @param {int} i - bit index
   * @param {array of byte} data - array data
   * @returns {bool}
   */
  parseDiscreateValue(i, data){
      if(data.length > i / 8){
        let bit = i % 8;
        let mask = 1 << bit;
        return (data[parseInt(i / 8)] & mask) > 0 ? 1 : 0;
      }
      return null;
  }

  /**
   * finishParse - creates result array of values
   * @param {string} cmd - read|write 
   * @param {array of objects} tags - tags objects array with options for requests
   * @param {int} transID - id transaction getting from server
   * @returns {array}
   */
  finishParse(cmd, tags, transID){
    let fullDeviceName = this.getFullDeviceAddress(tags);
    let values = [];
    if(cmd == 'read'){
      for(let tag of tags){
        if(tag.err){
          values.push({error: tag.err});
          continue;
        }
        if(this.clients[fullDeviceName][transID].values){
          values.push(this.clients[fullDeviceName][transID].values[tag.name]);
        }else{
          values.push(null);
        }
      }
    }
    return values;
  }

  /**
   * getSortedRegs - method sorts register in modbus address order
   * @param {array of objects} regs - array of modbus registers objects
   * @returns 
   */
  getSortedRegs(regs){
      regs.sort((a, b) => a.address - b.address);
      return regs;
  }

  /**
   * getDeviceProperty - common function-getter for device property
   * @param {array of objects} tags - tags objects array with options for requests
   * @param {string} property - property name
   * @returns {*} property value
   */
  getDeviceProperty(tags, property){
    for(let i = 0; i < tags.length; i++){
      if(tags[i][property] !== undefined) return tags[i][property];
    }
    return null;
  }

  /**
   * getHost - returns host name of modbus slave device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {string}
   */
  getHost(tags){
    return this.getDeviceProperty(tags, 'ip');
  }

  /**
   * getPort - returns port number of modbus slave device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {int}
   */
  getPort(tags){
    return this.getDeviceProperty(tags, 'port');
  }

  /**
   * getDeviceUid - returns unique identificator of device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {string}
   */
  getDeviceUid(tags){
    return this.getDeviceProperty(tags, 'deviceUid');
  }

  /**
   * getModbusDeviceId - returns id modbus slave device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {int}
   */
  getModbusDeviceId(tags){
    return this.getDeviceProperty(tags, 'modbusId');
  }

  /**
   * getTimeout - returns timeout for answering of modbus slave device
   * @param {array of objects} tags - tags objects array with options for requests
   * @returns {int}
   */
  getTimeout(tags){
    return this.getDeviceProperty(tags, 'timeout');
  }

  /**
   * getFullDeviceAddress - returns full device name in format "host:port"
   * @param {array of objects | string} ref - tags objects array with options for requests | device uid
   * @returns {string}
   */
  getFullDeviceAddress(ref){
    if(typeof(ref) == 'object'){
      if ((this.getHost(ref) !== null) && (this.getPort(ref) !== null))  return this.getHost(ref) + ':' + this.getPort(ref);
      return null;
    }else{
      try{
        let ip = this.nodeList.list[ref].options.modbusHost.currentValue;
        let port = this.nodeList.list[ref].options.modbusPort.currentValue;
        return ip + ':' + port;
      }catch(e){
        return null;
      }
    }
  }

}

// class implements common methods for modbus packet parsing
class Packet {
  /**
   * constructor method
   * @param {array} buffer = modbus data raw array 
   */
  constructor(buffer){
    this.packetIdIndex              = 0;
    this.packetModbusAddressIndex   = 6;
    this.packetModbusFuncIndex      = 7;
    this.packetModbusErrorCodeIndex = 8;
    this.packetModbusLenIndex       = 8;
    this.packetValuesIndex          = 9;
    this.buffer = buffer;
  }

  /**
   * getWord - returns word value from index position of buffer
   * @param {int} index - word value position
   * @returns {word}
   */
  getWord(index){
    if(this.buffer && this.buffer.length >= index + 2) return 0x100 * this.buffer[index] + this.buffer[index + 1];
    return null;
  }

  /**
   * getByte - returns byte value from index position of buffer
   * @param {int} index - byte value position
   * @returns {word}
   */
  getByte(index){
    if(this.buffer && this.buffer.length >= index) return this.buffer[index];
    return null;
  }

  /**
   * getId - returns packet id
   * @returns {word}
   */
  getId(){
    return this.getWord(this.packetIdIndex);
  }

  /**
   * getModbusAddress - returns device modbus id
   * @returns {byte}
   */
  getModbusAddress(){
    return this.getByte(this.packetModbusAddressIndex);
  }

  /**
   * getModbusFunc - returns modbus function code
   * @returns {byte}
   */
  getModbusFunc(){
    let modbusCode = this.getByte(this.packetModbusFuncIndex);
    return modbusCode & 0x7F;
  }

  /**
   * getModbusErrorStatus - checks error state
   * @returns {bool}
   */
  getModbusErrorStatus(){
    let modbusCode = this.getByte(this.packetModbusFuncIndex);
    return (modbusCode & 0x80) > 0;
  }

  /**
   * getModbusErrorCode - returns error code
   * @returns {byte}
   */
  getModbusErrorCode(){
    return this.getByte(this.packetModbusErrorCodeIndex);
  }

  /**
   * getValues - returns data block of packet
   * @returns {buffer}
   */
  getValues(){
    let len = this.getByte(this.packetModbusLenIndex);
    if(len) return this.buffer.slice(this.packetValuesIndex, this.packetValuesIndex + len);
    return null;
  }
}


module.exports = CustomDriver;
