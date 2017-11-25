var remotePool = require('./lib/pool_connector.js');
var logger = require('./lib/stratum_logger.js');
var info = require('./package.json');

class StratumService{
    constructor(){
        this.poolProxy = null;
    }
    startStratum(){
        logger.err("this method is not implemented");
    }

    restartStratum(){
        logger.warn("EQUIHASH STRATUM PROXY RESETING...");
        this.poolProxy.destroy();
        delete this.poolProxy;
        this.startStratum();
    }
}

class EquihashStratumService extends StratumService{
    startStratum(){
        logger.log("Equihash STRATUM PROXY "+ info.version +" STARTING...");        
        let configs = require('./configs/pools/equihash.json');
        this.poolProxy = new remotePool.EquihashPoolConnector(()=>{this.restartStratum();},configs);
    }
}

class CryptoNightStratumService extends StratumService{
    startStratum(){
        logger.log("CryptoNight STRATUM PROXY "+ info.version +" STARTING...");        
        let configs = require('./configs/pools/cryptonight.json');
        this.poolProxy = new remotePool.CryptoNightPoolConnector(()=>{this.restartStratum();},configs);
    }
}

// var equihashStratumService = new EquihashStratumService();
// equihashStratumService.startStratum();

var cryptonightStratumService = new CryptoNightStratumService();
cryptonightStratumService.startStratum();