// TODO: voir screenshot de l'erreur après update d'une playlist
// Ajouter caps sur les boutons?

var MPD = require('mpd');
var GPIO = require('rpi-gpio');
var LCD = require("i2c-lcd");
var _ = require('underscore');
var Promise = require('bluebird');
var assert = require('assert');
var request = require('request');
var winston = require('winston');

const tsFormat = function() { return (new Date()).toLocaleString(); };
const logger = new (winston.Logger)({
  transports: [
    new (winston.transports.Console)({
      timestamp: tsFormat,
      colorize: true,
      level: 'debug',
      tailable: true,
      maxFiles: 1,
      maxsize: 1000
    }),
    new (winston.transports.File)({ level: 'info', filename: __dirname+'/radi0.log' })
  ]
});

GPIO.setMode(GPIO.MODE_RPI);

var screen = new LCD("/dev/i2c-1", 0x27);
var playlist_url = "https://gist.githubusercontent.com/raphaelyancey/8fc80854b18bb8100c6382c08ad815eb/raw/";

screen.init().catch(function() {
  logger.warn('warning', "Couldn't find a LCD display.");
  screen = null;
});

// WIP
// Overloading the print function to either wrap the text
// on two lines, or display "…" if too long
// Maybe bouncing text also?
// screen.pprint = function(string, wrap) {
//   if(string.length < 16) return screen.print(string);
//   assert(typeof string === 'string');
//   if(wrap) {
//     return screen.setCursor(0, 0).then(function() {
//       return screen.print();
//     });
//   } else {

//   }
// };

var mpc = MPD.connect({
  port: 6600,
  host: 'localhost',
});


var updateDisplay = function() {
  if(!screen) return Promise.resolve();
  else {
    return getState().then(function(status) {
      if(status.state == 'play') {
        screen.init().then(function() {
          return screen.on();
        }).then(function() {
          return getCurrent();
        }).then(function(current) {
          screen.print(extractStationName(current.file));
        });
      } else {
        screen.init().then(function() {
          return screen.clear().then(function() {
            screen.off();
          });
        });
      }
    });
  }
};

var next = function() {
  logger.debug('> Next');
  mpdCommand("next").then(updateDisplay).catch(function(err) {
    winston.warn(err);
  });
};

var previous = function() {
  logger.debug('> Previous');
  mpdCommand("previous").then(updateDisplay).catch(function(err) {
    winston.warn(err);
  });
};

var power_toggle = function() {
  logger.debug('> Power toggle');
  getState().then(function(status) {
    var cmd;
    if(status.state == 'play') cmd = 'stop';
    else cmd = 'play';
    getAndUpdatePlaylist();
    mpdCommand(cmd).then(updateDisplay).catch(function(err) {
      winston.warn(err);
    });
  });
};

var pins = [{
  n: 16,
  action: power_toggle
},
{
  n: 15,
  action: next
},
{
  n: 11,
  action: previous
}];

function mpdCommand(cmd, args) {
  if(!args) args = [];
  return new Promise(function(resolve, reject) {
    mpc.sendCommand(MPD.cmd(cmd, args), function(err, msg) {
      if(err) {
        reject(err);
        throw err;
      }
      resolve(msg);
    });
  });
}

function parseMPDStatus(status) {
  var regex = /([^:\n]*):(.*)/g;
  var results = [], resultsObj = {}, match;
  while ((match = regex.exec(status)) !== null) results.push(match);
  _.each(results, function(result) {
    resultsObj[result[1].toLowerCase()] = result[2].trim();
  });
  return resultsObj;
}

function parseMPDPlaylist(playlist) {
  var regex = /(?:file\:)(.*)/g;
  var results = [], resultsObj = {}, match;
  while ((match = regex.exec(playlist)) !== null) results.push(match[1].trim());
  return results;
}

function handleCommandReturn(err, msg) {
  if(err) throw err;
  getState().then(function(state) {
    logger.info('state:', state);
  });
}

function getState() {
  return mpdCommand('status').then(function(status) {
    return parseMPDStatus(status);
  }).catch(function(err) {
    throw err;
  });
}

function getCurrent() {
  return mpdCommand('currentsong').then(function(current) {
    return parseMPDStatus(current);
  }).catch(function(err) {
    throw err;
  }); 
}

function extractStationName(file) {
  var match = /\?station_name=(.*)/g.exec(file);
  if(match) {
    var station = match[1];
    return station.replace(/_/g, function() { return " "; })
  } else return file;
}

function getPlaylist(url, callback) {
  return new Promise(function(resolve, reject) {
    var uncachedUrl = url + '?' + Date.now();
    //logger.info('> Getting playlist from', uncachedUrl);
    request(uncachedUrl, function (error, response, body) {
      if(!error && response.statusCode == 200) resolve(body.match(/[^\r\n]+/g));
      else reject(error);
    })
  });
}

function updatePlaylist(newPlaylist) {

  var commands = [];

  if(!_.isEmpty(newPlaylist)) {

    mpdCommand('playlistinfo')
      .then(parseMPDPlaylist)
      .then(function(currentPlaylist) {

        var toDelete = _.difference(currentPlaylist, newPlaylist);
        var toAdd = _.difference(newPlaylist, currentPlaylist);

        // TODO: delete only the streams missing from the new playlist (compute pos, etc)
        if(!_.isEmpty(toDelete)) {
          logger.info('> A stream has been deleted, re-creating the playlist');
          commands.push(mpdCommand('clear'));
          _.each(newPlaylist, function(stream) {
            logger.info('> Adding', stream);
            commands.push(mpdCommand('add', [stream]));
          });
          commands.push(mpdCommand('play')); // Because clearing the playlist stops the sound
        }
        else if(!_.isEmpty(toAdd)) {
          _.each(toAdd, function(stream) {
            logger.info('> Adding', stream);
            commands.push(mpdCommand('add', [stream]));
          });
        } else {
          //logger.info('> Nothing changed.');
        }
      });

    return Promise.all(commands).then(function(res) {
      logger.debug('Updated playlist.');
      return res;
    });
  }
}


mpc.on('ready', function() {
  logger.info("Connected to MPD");
  mpdCommand('repeat', ['1']).then(function() {
    winston.debug('MPD set to repeat.');
  }).catch(function() {
    winston.warn("Couldn't set MPD to repeat.");
  });
  updateDisplay();
});

// GPIO flooding detection
var lastRisingTime = process.hrtime();
var isFlooding = function(lastTime) {
  var diff = process.hrtime(lastTime);
  var minDiff = 0.2 * 1000 * 1000 * 1000;
  return diff[0] == 0 && diff[1] < minDiff;
};

// Buttons handling
GPIO.on('change', function(n, value) {
  if(isFlooding(lastRisingTime)) return;
  lastRisingTime = process.hrtime();
  var pin = _.findWhere(pins, { n: n });
  if(value === true && pin) pin.action();
});

// Pins setup
_.each(pins, function(pin) {
  GPIO.setup(pin.n, GPIO.DIR_IN, GPIO.EDGE_RISING, function(err) {
    if(err) {
      logger.info(err);
      throw new Error("Couldn't setup pin #"+pin.n);
    } else {
      GPIO.read(pin.n, function(err, value) {
        if(value) throw new Error("Pin #"+pin.n+" value shouldn't be 1 at startup");
        logger.info('Pin #'+pin.n+' is set up');
      });
    }
  });
});

// Wrapper for getting the playlist + local update
function getAndUpdatePlaylist() {
  getPlaylist(playlist_url)
    .then(updatePlaylist)
    .catch(function(err) {
      logger.info("Couldn't fetch the remote playlist. Continuing anyway.");
    });
}