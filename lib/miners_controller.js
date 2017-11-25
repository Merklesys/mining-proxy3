var net  = require('net');
var util = require('util');
var ldj  = require('ndjson');
const chalk = require('chalk');

var logger = require('./stratum_logger');
var info = require('../package.json');
var minerController = require('./miner_controller');

class MinersController{
    constructor(poolproxy,poolconfig){
        this.config = poolconfig;
        this.miners = new Map();
        this.proxy = poolproxy;
        this.id = 10;
        this.totalRejectedShares = 0;
        logger.dbg('[INFO] Workers controller created');
        this.listener = net.createServer((newConnection)=>{
            this.onConnect(newConnection);
        }).listen(this.config.stratum.port,this.config.stratum.bind);
    }

    onConnect(newConnection,controller){
        logger.err("this method is not implemented");
    }

    broadcastToMiners(obj){
        this.miners.forEach(function(value,key) {
            value.send(obj);
        });
    }

    sendToMiner(peer_id,obj){
        logger.dbg('[MINER<'+peer_id+'>:SEND] ',obj);
        if(this.miners.get(peer_id)){
            this.miners.get(peer_id).send(obj);
        }else{
            logger.dbg('[MINER<'+peer_id+'>] OffLine');
        }
    }

    removeMiner(peer_id){
        this.miners.delete(peer_id);
        logger.dbg('[MINERS] ALIVE PEERS :');
        this.miners.forEach(function(value,key) {
            logger.dbg('[MINER<'+key+'>]');
        });
    }

    destroy(obj){
        logger.dbg('[MINERS] Destroy controller');
        this.listener.close();
        delete this.listener;
        this.listener = null;
        this.reset();
    }

    reset(obj){
        logger.dbg('[MINERS] Close workers connections');
        this.miners.forEach( (miner,peer_id) => {
            logger.dbg('  >> Close miner connection ' + miner.name);
            miner.connection.end();
            delete miner.connection;
            miner.connection = null;
            this.miners.delete(peer_id);
        });
    }

    outputRegSharesStats(){
        logger.err('Too many rejected shares : ' + this.totalRejectedShares);
        this.miners.forEach(function(value,key) {
            logger.warn(' - ' + value.name + ' : ' + value.rejectedShares + ' shares rejected');
        });
    }
}

class EquihashMinersController extends MinersController{
    
    onConnect(newConnection){
        var miner = new minerController.EquihashMiner(newConnection,this,this.config); // create new miner
        this.miners.set(this.id, miner); // add it
        logger.dbg('[INFO] Active miners : '+ this.miners.size);
    }
}
class CryptoNightMinersController extends MinersController{
    
    onConnect(newConnection){
        var miner = new minerController.CryptoNightMiner(newConnection,this,this.config); // create new miner
        this.miners.set(this.id, miner); // add it
        logger.dbg('[INFO] Active miners : '+ this.miners.size);
    }
}

module.exports = {
    EquihashMinersController,
    CryptoNightMinersController
};