module.exports = {
  apps : [
    {
      name      : 'radi0',
      script    : __dirname + '/main.js',
      instances: 1,
      //watch: true,
      //max_memory_restart: '100M',
      max_restarts: 10,
      exec_mode: 'fork'
    }
  ]
};
