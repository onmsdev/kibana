import _ from 'lodash';
import handleESError from '../../../lib/handle_es_error';
import {
  searchClientInit,
  queryWithoutSideEffects
} from './search_client'
/*
* Our lone servervice method, separated the file to accomodate easy
*  additions in future
*/
export function registerExport(server) {
  searchClientInit(server);
  server.route({
    path: '/api/kibana/export',
    method: ['GET', 'POST'],
    handler: function(req, reply) {
      queryWithoutSideEffects(req).then(function(res) {
        if (res != 'undefined' && res.hits && res.hits.hits) {
          //For testing
          //setTimeout(function() {
            reply(res.hits.hits);
          //},6000);
        } else {
          reply({});
        }
      });
    }
  });
}