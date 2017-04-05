import _ from 'lodash';
import handleESError from '../../../lib/handle_es_error';
import {
  searchClientInit,
  queryWithoutSideEffects
} from './search_client'

export function registerExport(server) {
  searchClientInit(server);
  server.route({
    path: '/api/kibana/export/{id}',
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