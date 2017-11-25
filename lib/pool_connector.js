var net  = require('net');
var util = require('util');
var ldj  = require('ndjson');
const chalk = require('chalk');

var logger = require('./stratum_logger');
var info = require('../package.json');
var minersController = require('./miners_controller');

class PoolConnector{
    constructor(restartCallback,poolConfig){
        this.config = poolConfig;
        this.status = "offline";
        this.miners = null;
        this.sessionId = null;
        
        this.last_target = null;
        this.last_notif = null;
        this.poollist = [];
        this.current_pool = null;
        this.restartCallback = restartCallback;
        this.poollist.push(poolConfig.pool);

        this.connect(true);
    }

    onConnect(connect){
        logger.err("this method is not implemented");
    }

    onError(error){
        logger.err('Network error, ' + error);
        if(error.code == 'ECONNRESET'){ // connection lost, retry on same pool
            this.connect(false);
        }else{ // Try with next pool
            this.connect(true);
        }
    }

    onData(obj){
        logger.err("this method is not implemented");
    }

    onEnd(){
        logger.log('Pool closed the connection...');
        this.reset();
    }

    send(obj){
        logger.dbg('[POOL:OUT] send ' + obj.method + ': ' + JSON.stringify(obj));
        this.poolSocket.write(JSON.stringify(obj) + '\n');
    }

    submit(minerId,obj){
        obj.id = minerId;
        logger.dbg('[POOL:OUT] submit ' + obj.method + ': ' + JSON.stringify(obj));
        this.poolSocket.write(JSON.stringify(obj) + '\n');
    }

    error(msg){
        logger.err("Proxy failure on state " + this.status + ' ' + msg);
        this.poolSocket.end();
    }

    reset(){
        if(this.poolSocket){
            logger.err('Closing all connections...');
            this.destroy();
            logger.err("Waiting "+ this.config.restart_delay+" seconds before attempting to restart the Stratum Proxy");
            setTimeout( () => { this.restartCallback(); },this.config.restart_delay * 1000);
          }
    }

    destroy(){
        if(this.poolSocket){
            this.poolSocket.end();
            delete this.poolSocket;
            this.poolSocket = null;
        }
        if(this.miners){
            this.miners.destroy();
            delete this.miners;
            this.miners = null;
        }
    }

    connect(try_next_pool){
        if(this.poollist.length > 0){
            if(try_next_pool){
                this.current_pool = this.poollist.shift();
            }
            
            if(this.poolSocket){
                this.poolSocket.end();
                delete this.poolSocket;
                this.poolSocket = null;
            }
            
            this.status = "offline";
            logger.log(chalk.bold('Connecting to ' + this.current_pool.host +":"+this.current_pool.port) );
            
            if(this.current_pool.ssl){
                this.poolSocket = tls.connect(this.current_pool.port, this.current_pool.host, () => {
                    if (this.poolSocket.authorized) {
                      // authorization successful
                      logger.log( chalk.bold('SSL') + ' authorization ' + chalk.green('successful') + '...');
                    } else {
                       // authorization failed
                       logger.log( chalk.bold('SSL') + ' authorization ' + chalk.red('failed') + '...');
                       this.onError('SSL authorization failed for ' + this.current_pool.host + ':' + this.current_pool.port);
                    }
                 });
            }else{
                this.poolSocket = net.createConnection({
                    port: this.current_pool.port,
                    host: this.current_pool.host
                });
            }
            
            this.poolSocket.on('connect', (connect)=>{this.onConnect(connect);});
            this.poolSocket.on('error', (err)=>{this.onError(err);});
            this.poolSocket.on('data', (data)=>{})
                .pipe(ldj.parse({strict: true}))
                .on('data',(data)=>{ this.onData(data); })
                .on('error',(e)=>{ logger.err("invalid pool request, "+e); });
            this.poolSocket.on('end',()=>{this.onEnd();});
        }else{
            logger.err('All connections failed...');
            this.reset();
        }
       
        
    }


}

class EquihashPoolConnector extends PoolConnector{
    
    onData(obj){
        logger.dbg('====================================')
        logger.dbg('[POOL:IN] ' + JSON.stringify(obj));
        if(this.poolSocket != null){
            switch (this.status) {
                case 'subscribing':// Subscription (internal)
                    if(obj.id==1){
                        if(obj.error){
                            this.error(obj.error);
                        }else{
                            this.authorize(obj);
                        }
                    }
                    break;
                case 'authorizing':// Authorization (internal)
                    if(obj.id==2){
                        if (obj.error) {
                            this.error(obj.error);
                        } else if (obj.result) {
                            this.extranonceSubscribe();
                        } else {
                            logger.log('Mining wallet ' + this.config.wallet + chalk.red(' authorization failed') );
                        }
                    }
                    break;
                case 'mining.notify':
                    logger.log('New work : ' + obj.params[3]);
                    this.last_notif = obj.params;
                    // Broadcast to all miners
                    this.miners.broadcastToMiners(obj);
                case 'mining.set_target':
                    this.last_target = obj.params;
                    logger.log('New target : ' + obj.params[0]);
                    // Broadcast to all miners
                    this.miners.broadcastToMiners(obj);
                    break;
                default://Forward message to the correct miner
                    this.miners.sendToMiner(obj.id, obj);
                    break;
            }
        }else{
            logger.dbg('[POOL:IN] IGNORED');
        }
        logger.dbg('====================================')
    };
    onConnect(connect){
        logger.log("Connected to pool "+ this.current_pool.host + ":" + this.current_pool.port);
        if(this.miners){// Reset workers connections
            logger.warn('Resetting workers...');
            this.miners.reset();
        }else{
            logger.warn('Creating workers listner...');
            this.miners = new minersController.EquihashMinersController(this,this.config);
        }
        this.subscribe();
    }
    subscribe(){
        // Subscribe to pool
        logger.log('Subscribing to pool...');
        var sub = { id: 1
                  , method:"mining.subscribe"
                  , params: [ "","", "Stratum proxy" ]};
        this.status = "subscribing";
        this.send(sub);
    }
    authorize(obj){
        this.sessionId = obj.result[1];
        logger.log('Stratum session id ' + this.sessionId);
        var auth = { id: 2
                , method: "mining.authorize"
                , params: [ this.config.wallet + "." + this.config.proxy_name
                            , this.config.password ]
        };
        logger.log('Authorizing mining wallet '+ this.config.wallet);
        this.status = "authorizing";
        this.send(auth);
    }
    extranonceSubscribe(){
        this.status = 'ready';
        logger.log('Mining wallet ' + this.config.wallet + chalk.green(' authorization granted') );
        var xtra = { id: 3
                , method: "mining.extranonce.subscribe"
                , params:[]
        }
        this.send(xtra);
    }

}

module.exports = {
    EquihashPoolConnector
};