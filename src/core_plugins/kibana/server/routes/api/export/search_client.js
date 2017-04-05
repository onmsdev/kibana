/* This file is the bulk of our interaction with Elastic
*  Comment reproduced from disocver controller below for convenience
*
* The main design choice is to use our own AJAX transport to elastic.
*  Discover's built in transport (aka 'fetch') has a lot of side effects.
*  Also there is a limitation on result set size where in one cannot change 
*  Discovers fetch result size setting without affecting Kibana globally.
* Our own transport sidesteps both of these problems.
* 
*/


var es = require('elasticsearch');
var esClient = {};

export function searchClientInit(server) {
 
 /*
 * This method is maily to read in kibana configuration from 
 * elastic( defaultIndexPattern etc..,)
 */
  esClient.config = {};
  esClient.config.esURL = server.config().get('elasticsearch.url');
  esClient.configDefaultKibanaIndex = server.config().get('kibana.index');

  //this value will be set to correect value once configs are read
  esClient.config.defaultKibanaIndexPattern = '*';

  esClient.client = new es.Client({
    host: esClient.config.esURL
    /** // Add line below for debugging elastic calls
    log: 'trace'
    **/
  });

  esClient.client.search({
    index: esClient.configDefaultKibanaIndex,
    filterPath: 'hits.total, hits.hits._source.defaultIndex',
    body: {
      "query": {
        "match": {
          "_type": "config"
        }
      }
    }
  }).then(function(config) {
    if (config.hits.total > 0) {
      var defaultIndexElement = config.hits.hits.find(function(ele) {
        return (typeof ele._source != 'undefined' && typeof ele._source.defaultIndex != 'undefined');
      });
      esClient.config.defaultKibanaIndexPattern = defaultIndexElement._source.defaultIndex;
    } else {
      console.trace('ERROR retrieving Kibana Configs. ');
    }
  }, function() {
    console.trace('ERROR retrieving Kibana Configs. ' + err.message);
  });

}

/*
* This method is similar to discover's 'fetch' but without side effects
* returns a promise. 
*/

export function queryWithoutSideEffects(request) {

  var _queryPromiseResolve = {};

  var queryPromise = new Promise(function(resolve) {
    _queryPromiseResolve = resolve;
  });

  var fieldPrefix = 'hits.hits._source.';

  var _filterPath = request.payload.selectedFields.map(function(element) {
    return (fieldPrefix + element);
  });

  var qBody = getDefaultBody();
  if (request.payload.size === '*') {
    qBody.size = request.payload.hits;
  } else {
    qBody.size = request.payload.size;
  }
  setParam(qBody, "query_string", request.payload.query_string);
  setParam(qBody, "timestamp", request.payload.timestamp);


  esClient.client.search({
    index: esClient.config.defaultKibanaIndexPattern,
    filterPath: 'hits.hits._index,' + _filterPath.join(),
    body: qBody
  }).then(function(response) {
    _queryPromiseResolve(response);

  }, function(err) {
    console.trace(err.message);
  });

  return queryPromise;
}

function setParam(obj, name, value) {
  var attribute = {};
  if (name == "query_string") {
    attribute.query_string = value;
  } else if (name == "timestamp") {
    attribute.range = {};
    attribute.range["@timestamp"] = value;
  }
  obj.query.bool.must.push(attribute);
}

function getDefaultBody() {
  return {
    "size": 5,
    "sort": [{
      "@timestamp": {
        "order": "desc",
        "unmapped_type": "boolean"
      }
    }],
    "query": {
      "bool": {
        "must": [],
        "must_not": []
      }
    }
  }
}