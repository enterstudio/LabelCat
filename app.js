// Copyright 2015, Google, Inc. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

// Express and http server
let express = require('express');
let http = require('http');

// Middleware
let bodyParser = require('body-parser');
let session = require('cookie-session');
let csurf = require('csurf');

// Initialize IOC container
let container = require('./container');

// By exporting our Express app creation functionality we can more easily write tests.
exports.createServer = function () {

  // Pull an initial set of dependencies from our IOC container
  return container.resolve(function (config, utils, auth, logger, jsonpSecurity, ensureAuthenticated, errorHandler, user, repos, models) {
    let app = express();

    app.disable('etag');
    app.use(jsonpSecurity); // Fix res.json to safely handle JSON vulnerability
    app.use(bodyParser.json()); // parse application/json

    // Setup static file folder
    app.use(express.static(`${__dirname}/public`));

    // Configure the session and session storage.
    // MemoryStore isn't viable in a multi-server configuration, so we
    // use encrypted cookies. Redis or Memcache is a great option for
    // more secure sessions, if desired.
    app.use(session({
      secret: config.secret,
      signed: true
    }));

    // Cross-site Request Forgery protection.
    // A csrf token will automatically be stored in the user's cookie session.
    app.use(csurf());

    // Set the CSRF cookie
    app.use(function (req, res, next) {
      res.cookie('XSRF-TOKEN', req.csrfToken());
      return next();
    });

    // Activate our GitHub authentication middleware
    app.use(auth.initialize());
    app.use(auth.session());

    // Log every request
    app.use(logger.requestLogger);

    // GitHub authentication endpoints
    app.get('/auth/github', auth.authenticate('github', {
      scope: [config.github.accessLevel === 'private' ? 'repo' : 'public_repo']
    }));
    app.get('/auth/github/callback', auth.authenticate('github', {
      failureRedirect: '/login'
    }), function (req, res) {
      res.redirect('/');
    });

    app.get('/api/logout', function (req, res) {
      req.logout();
      res.redirect('/');
    });

    // Return the currently authenticated user, if any
    app.get('/api/user', utils.makeSafe(user.user));
    // Return the accessible repos of the currently authenticated user, if any
    app.get('/api/user/repos', ensureAuthenticated, utils.makeSafe(user.repos));

    // Trigger training for the specified model
    app.post('/api/models/:key/train', ensureAuthenticated, utils.makeSafe(models.trainOne));

    app.route('/api/models')
    // Return a collection of models
    .get(ensureAuthenticated, utils.makeSafe(models.findAll))
    // Create a new model
    .post(ensureAuthenticated, utils.makeSafe(models.createOne));

    app.route('/api/models/:key')
      // Return a model
      .get(ensureAuthenticated, utils.makeSafe(models.findOne))
      // Update a model
      .put(ensureAuthenticated, utils.makeSafe(models.updateOne))
      // Delete a model
      .delete(ensureAuthenticated, utils.makeSafe(models.destroyOne));

    // Receiving a GitHub webhook on issue creation
    app.post('/api/repos/:key/hook', utils.makeSafe(repos.hook));

    // Search GitHub for a repo with the specified owner and name    
    app.get('/api/repos/search/:owner/:repo', ensureAuthenticated, utils.makeSafe(repos.search))
    app.route('/api/repos/:key')
      // Return a repo
      .get(ensureAuthenticated, utils.makeSafe(repos.findOne))
      // Update a repo
      .put(ensureAuthenticated, utils.makeSafe(repos.updateOne))
      // Delete a repo
      .delete(ensureAuthenticated, utils.makeSafe(repos.destroyOne));
    app.route('/api/repos')
      // Return a repo
      .get(ensureAuthenticated, utils.makeSafe(repos.findAll));

    // Catch any other unknown requests by rendering the home page
    app.get('*', function (req, res, next) {
      return res.sendFile('index.html', {
        root: './public/'
      });
    });

    // Add the error logger after all middleware and routes so that
    // it can log errors from the whole application. Any custom error
    // handlers should go after this.
    app.use(logger.errorLogger);

    // Catch all handler, assumes error
    app.use(errorHandler);

    return app;
  });
};

// Only initialize http server if this file is actually being executed as the "main"
// entry point of the program. The other case is that this file is being pulled into
// one of our tests.
if (module === require.main) {
  var config = container.get('config');
  var app = exports.createServer();
  var server = http.createServer(app).listen(config.port, config.host, function () {
    console.log(`App listening at http://${server.address().address}:${server.address().port}`);
    console.log('Press Ctrl+C to quit.');
  });
}