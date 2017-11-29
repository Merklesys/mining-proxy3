var net = require('net');
var util = require('util');
var ldj = require('ndjson');
const chalk = require('chalk');
var redis = require("redis"),
redisClient = redis.createClient();

var logger = require('./stratum_logger');
var info = require('../package.json');


class Miner {
    constructor(connection, controller, poolconfig) {
        logger.dbg('[MINER:NEW_MINER]');
        this.config = poolconfig;
        this.id = ++controller.id;
        this.ctrl = controller;
        this.name = 'noname';
        this.connection = connection;
        this.status = "none";
        this.reqid = 0;
        this.rejectedShares = 0;
        this.lastReqId = 0;
        this.connection.on('error', (err) => { this.onError(err); });
        this.connection.on('data', (data) => { })
            .pipe(ldj.parse({ strict: true }))
            .on('data', (data) => { this.onData(data); })
            .on('error', (e) => { logger.err("invalid worker request, " + e); });
        this.connection.on('end', () => { this.onEnd(); });
    }

    onError(error) {
        logger.dbg('[MINER<' + this.id + '>:ERROR] ', error);
    }

    onData(obj) {
        logger.err("this method is not implemented");
    }

    Error(msg) {
        logger.err("Miner failure on state " + this.status, msg);
        this.send({ id: this.lastReqId, error: msg });
    }

    onEnd() {
        logger.warn("peer " + chalk.blueBright(this.name) + " disconnected");
        logger.dbg('[MINER<' + this.id + '>:DISCONNECTED] ');
        this.ctrl.removeMiner(this.id);
        logger.log(this.ctrl.miners.size + " peer(s) mining on this proxy");
    }

    onRejected() {
        this.ctrl.totalRejectedShares++;
        this.rejectedShares++;
        if (this.ctrl.totalRejectedShares >= this.config.on_rejected_share.threshold) {
            this.ctrl.outputRegSharesStats();
            if (this.config.on_rejected_share != null) {
                switch (this.config.on_rejected_share.strategy) {
                    case "restart":
                        this.ctrl.proxy.reset();
                        break;
                    case "kill":
                        process.exit(1);
                        break;
                    default: // NOP
                        break;
                }
            }
        }
    }

    send(data) {
        logger.err("this method is not implemented");
    }

}

class EquihashMiner extends Miner {
    onData(obj) {
        logger.dbg('[EquihashMiner<' + this.id + '>:IN] ' + JSON.stringify(obj));
        if (this.connection) {
            this.lastReqId = obj.id;
            if (obj.method == "mining.subscribe") {
                if (this.ctrl.proxy.sessionId == null) {
                    this.Error("No pool session id");
                } else {
                    this.send({ id: this.lastReqId, result: [this.ctrl.proxy.sessionId, this.ctrl.proxy.sessionId], error: null });
                }
            } else if (obj.method == "mining.authorize") {
                logger.log("New peer connected : " + chalk.blueBright(obj.params[0]));
                this.name = obj.params[0];
                if (this.ctrl.proxy.status != "ready") {
                    this.Error("Proxy not authorised yet");
                } else {

                    logger.log(this.ctrl.miners.size + " peer(s) mining on this proxy");
                    this.send({ id: this.lastReqId, result: true, error: null });
                    this.send({ id: null, method: "mining.set_target", params: this.ctrl.proxy.last_target });
                    this.send({ id: null, method: "mining.notify", params: this.ctrl.proxy.last_notif });
                }
            } else if (obj.method == "mining.submit") {
                this.status = "submit";
                obj.params[0] = this.config.wallet;
                if (this.config.enable_worker_id) {
                    obj.params[0] = obj.params[0] + "." + this.name;
                }
                logger.log("Submit work for " + this.name);
                this.ctrl.proxy.submit(this.id, obj);
            }
        }
    }

    send(data) {
        logger.dbg('[MINER<' + this.id + '>:OUT] ', data);
        if (data.method && data.method == 'mining.notify') {
            // New work notification
            logger.dbg('[MINER<' + this.id + '>] Notify ' + this.name + ' for new work');
        } else if (this.status == "subscribe") {
            // Worker subscription
            data.id = this.lastReqId;
            logger.dbg('[MINER<' + this.id + '>] Subscribe result', data);
        } else if (this.status == "authorize") {
            // Worker subscription
            data.id = this.lastReqId;
            logger.dbg('[MINER<' + this.id + '>] Authorize result', data);
        } else if (this.status == "submit") {
            // Work submition
            data.id = this.lastReqId;
            logger.dbg('[MINER<' + this.id + '>] Submit result', data);
            if (data.result) {
                logger.log("Work from " + this.name + " " + chalk.green("accepted"));
            } else if (data.method && data.method === 'mining.set_target') {
                // method is returned from some pools and not others
                logger.log("Setting target for " + this.name + " " + chalk.blue(data.params[0]));
            } else if (data.error && data.error.length > 1) {
                // error is returned from some pools and not others
                logger.log("Work from " + this.name + " " + chalk.red("rejected: " + data.error[1]));
                this.onRejected();
            } else {
                logger.log("Work from " + this.name + " " + chalk.red("rejected"));
                this.onRejected();
            }
        }
        if (this.connection && !(this.connection.destroyed)) {
            this.connection.write(JSON.stringify(data) + '\n');
        } else {
            logger.err(this.name + " offline... removing from pool");
            this.ctrl.removeMiner(this.id);
        }
    }
}

class CryptoNightMiner extends Miner {
    onData(obj) {
        logger.dbg('[CryptoNightMiner<' + this.id + '>:IN] ' + JSON.stringify(obj));
        if (this.connection) {
            if (obj.id) {
                this.lastReqId = obj.id;
            }
            switch (obj.method) {
                case 'login':
                    if (this.ctrl.proxy.sessionId == null) {
                        this.Error("No pool session id");
                    } else {
                        this.name = obj.params.login;
                        this.send({ 
                            id: this.lastReqId, 
                            result: {
                                id:this.ctrl.proxy.sessionId,
                                status:"OK",
                                job:this.ctrl.proxy.last_job
                            },
                            error: null
                        });
                    }
                    break;
                case 'submit':
                    this.status = "submit";
                    logger.log("Submit work for " + this.name);
                    this.ctrl.proxy.submit(this.id, obj);
                    break;
                default:
                    logger.warn("Not processed"+ obj);
                    break;
            }
        }

    }

    send(data) {
        if (data.id) {
            data.id = this.lastReqId;
        }
        if (this.status == "submit") {
            // Work submition
            data.id = this.lastReqId;
            logger.dbg('[MINER<' + this.id + '>] Submit result', data);
            if (data.result && data.result.status == "OK") {
                logger.log("Work from " + this.name + " " + chalk.green("accepted"));
                redisClient.hincrby('cryptonight:shares:' + this.ctrl.proxy.last_target,this.name,1);
            } else if (data.error && data.error.length > 1) {
                // error is returned from some pools and not others
                logger.log("Work from " + this.name + " " + chalk.red("rejected: " + data.error[1]));
                this.onRejected(); return;
            } else {
                logger.log("Work from " + this.name + " " + chalk.red("rejected"));
                this.onRejected(); return;
            }
        }

        if (this.connection && !(this.connection.destroyed)) {
            this.connection.write(JSON.stringify(data) + '\n');
        } else {
            logger.err(this.name + " offline... removing from pool");
            this.ctrl.removeMiner(this.id);
        }
    }
}

module.exports = {
    EquihashMiner,
    CryptoNightMiner
};