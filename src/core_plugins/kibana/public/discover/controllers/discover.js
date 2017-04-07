import _ from 'lodash';
import angular from 'angular';
import moment from 'moment';
import getSort from 'ui/doc_table/lib/get_sort';
import dateMath from '@elastic/datemath';
import 'ui/doc_table';
import 'ui/visualize';
import 'ui/notify';
import 'ui/fixed_scroll';
import 'ui/directives/validate_json';
import 'ui/filters/moment';
import 'ui/courier';
import 'ui/index_patterns';
import 'ui/state_management/app_state';
import 'ui/timefilter';
import 'ui/highlight/highlight_tags';
import 'ui/share';
import VisProvider from 'ui/vis';
import DocTitleProvider from 'ui/doc_title';
import UtilsBrushEventProvider from 'ui/utils/brush_event';
import PluginsKibanaDiscoverHitSortFnProvider from 'plugins/kibana/discover/_hit_sort_fn';
import FilterBarQueryFilterProvider from 'ui/filter_bar/query_filter';
import FilterManagerProvider from 'ui/filter_manager';
import AggTypesBucketsIntervalOptionsProvider from 'ui/agg_types/buckets/_interval_options';
import stateMonitorFactory from 'ui/state_management/state_monitor_factory';
import uiRoutes from 'ui/routes';
import uiModules from 'ui/modules';
import indexTemplate from 'plugins/kibana/discover/index.html';
import StateProvider from 'ui/state_management/state';
import fsaver from 'plugins/kibana/discover/lib/file-saver';

const app = uiModules.get('apps/discover', [
  'kibana/notify',
  'kibana/courier',
  'kibana/index_patterns'
]);

uiRoutes
  .defaults(/discover/, {
    requireDefaultIndex: true
  })
  .when('/discover/:id?', {
    template: indexTemplate,
    reloadOnSearch: false,
    resolve: {
      ip: function(Promise, courier, config, $location, Private) {
        const State = Private(StateProvider);
        return courier.indexPatterns.getIds()
          .then(function(list) {
            /**
             *  In making the indexPattern modifiable it was placed in appState. Unfortunately,
             *  the load order of AppState conflicts with the load order of many other things
             *  so in order to get the name of the index we should use, and to switch to the
             *  default if necessary, we parse the appState with a temporary State object and
             *  then destroy it immediatly after we're done
             *
             *  @type {State}
             */
            const state = new State('_a', {});

            const specified = !!state.index;
            const exists = _.contains(list, state.index);
            const id = exists ? state.index : config.get('defaultIndex');
            state.destroy();

            return Promise.props({
              list: list,
              loaded: courier.indexPatterns.get(id),
              stateVal: state.index,
              stateValFound: specified && exists
            });
          });
      },
      savedSearch: function(courier, savedSearches, $route) {
        return savedSearches.get($route.current.params.id)
          .catch(courier.redirectWhenMissing({
            'search': '/discover',
            'index-pattern': '/management/kibana/objects/savedSearches/' + $route.current.params.id
          }));
      }
    }
  });

app.directive('discoverApp', function() {
  return {
    restrict: 'E',
    controllerAs: 'discoverApp',
    controller: discoverController
  };
});

function discoverController($scope, config, courier, $route, $window, Notifier,
  AppState, timefilter, Promise, Private, kbnUrl, highlightTags, $http) {

  const Vis = Private(VisProvider);
  const docTitle = Private(DocTitleProvider);
  const brushEvent = Private(UtilsBrushEventProvider);
  const HitSortFn = Private(PluginsKibanaDiscoverHitSortFnProvider);
  const queryFilter = Private(FilterBarQueryFilterProvider);
  const filterManager = Private(FilterManagerProvider);

  const notify = new Notifier({
    location: 'Discover'
  });

  $scope.intervalOptions = Private(AggTypesBucketsIntervalOptionsProvider);
  $scope.showInterval = false;

  $scope.intervalEnabled = function(interval) {
    return interval.val !== 'custom';
  };

  $scope.toggleInterval = function() {
    $scope.showInterval = !$scope.showInterval;
  };
  $scope.topNavMenu = [{
    key: 'new',
    description: 'New Search',
    run: function() {
      kbnUrl.change('/discover');
    },
    testId: 'discoverNewButton',
  }, {
    key: 'save',
    description: 'Save Search',
    template: require('plugins/kibana/discover/partials/save_search.html'),
    testId: 'discoverSaveButton',
  }, {
    key: 'open',
    description: 'Open Saved Search',
    template: require('plugins/kibana/discover/partials/load_search.html'),
    testId: 'discoverOpenButton',
  }, {
    key: 'share',
    description: 'Share Search',
    template: require('plugins/kibana/discover/partials/share_search.html'),
    testId: 'discoverShareButton',
  }, {
    key: 'export',
    description: 'Export Search Results',
    template: require('plugins/kibana/discover/partials/export_results.html'),
    testId: 'discoverExportButton',
  }];
  $scope.timefilter = timefilter;


  // the saved savedSearch
  const savedSearch = $route.current.locals.savedSearch;
  $scope.$on('$destroy', savedSearch.destroy);

  // the actual courier.SearchSource
  $scope.searchSource = savedSearch.searchSource;
  $scope.indexPattern = resolveIndexPatternLoading();
  $scope.searchSource.set('index', $scope.indexPattern);

  if (savedSearch.id) {
    docTitle.change(savedSearch.title);
  }

  let stateMonitor;
  const $appStatus = $scope.appStatus = this.appStatus = {};
  const $state = $scope.state = new AppState(getStateDefaults());
  $scope.uiState = $state.makeStateful('uiState');

  function getStateDefaults() {
    return {
      query: $scope.searchSource.get('query') || '',
      sort: getSort.array(savedSearch.sort, $scope.indexPattern),
      columns: savedSearch.columns.length > 0 ? savedSearch.columns : config.get('defaultColumns'),
      index: $scope.indexPattern.id,
      interval: 'auto',
      filters: _.cloneDeep($scope.searchSource.getOwn('filter'))
    };
  }

  $state.index = $scope.indexPattern.id;
  $state.sort = getSort.array($state.sort, $scope.indexPattern);

  $scope.$watchCollection('state.columns', function() {
    $state.save();
  });

  $scope.opts = {
    // number of records to fetch, then paginate through
    sampleSize: config.get('discover:sampleSize'),
    // Index to match
    index: $scope.indexPattern.id,
    timefield: $scope.indexPattern.timeFieldName,
    savedSearch: savedSearch,
    indexPatternList: $route.current.locals.ip.list,
    timefilter: $scope.timefilter
  };

  const init = _.once(function() {
    const showTotal = 5;
    $scope.failuresShown = showTotal;
    $scope.showAllFailures = function() {
      $scope.failuresShown = $scope.failures.length;
    };
    $scope.showLessFailures = function() {
      $scope.failuresShown = showTotal;
    };

    stateMonitor = stateMonitorFactory.create($state, getStateDefaults());
    stateMonitor.onChange((status) => {
      $appStatus.dirty = status.dirty;
    });
    $scope.$on('$destroy', () => stateMonitor.destroy());

    $scope.updateDataSource()
      .then(function() {
        $scope.$listen(timefilter, 'fetch', function() {
          $scope.fetch();
        });

        $scope.$watchCollection('state.sort', function(sort) {
          if (!sort) return;

          // get the current sort from {key: val} to ["key", "val"];
          const currentSort = _.pairs($scope.searchSource.get('sort')).pop();

          // if the searchSource doesn't know, tell it so
          if (!angular.equals(sort, currentSort)) $scope.fetch();
        });

        // update data source when filters update
        $scope.$listen(queryFilter, 'update', function() {
          return $scope.updateDataSource().then(function() {
            $state.save();
          });
        });

        // update data source when hitting forward/back and the query changes
        $scope.$listen($state, 'fetch_with_changes', function(diff) {
          if (diff.indexOf('query') >= 0) $scope.fetch();
        });

        // fetch data when filters fire fetch event
        $scope.$listen(queryFilter, 'fetch', $scope.fetch);

        $scope.$watch('opts.timefield', function(timefield) {
          timefilter.enabled = !!timefield;
        });

        $scope.$watch('state.interval', function(interval, oldInterval) {
          if (interval !== oldInterval && interval === 'auto') {
            $scope.showInterval = false;
          }
          $scope.fetch();
        });

        $scope.$watch('vis.aggs', function() {
          // no timefield, no vis, nothing to update
          if (!$scope.opts.timefield) return;

          const buckets = $scope.vis.aggs.bySchemaGroup.buckets;

          if (buckets && buckets.length === 1) {
            $scope.intervalName = 'by ' + buckets[0].buckets.getInterval().description;
          } else {
            $scope.intervalName = 'auto';
          }
        });

        $scope.$watchMulti([
          'rows',
          'fetchStatus'
        ], (function updateResultState() {
          let prev = {};
          const status = {
            LOADING: 'loading', // initial data load
            READY: 'ready', // results came back
            NO_RESULTS: 'none' // no results came back
          };

          function pick(rows, oldRows, fetchStatus) {
            // initial state, pretend we are loading
            if (rows == null && oldRows == null) return status.LOADING;

            const rowsEmpty = _.isEmpty(rows);
            // An undefined fetchStatus means the requests are still being
            // prepared to be sent. When all requests are completed,
            // fetchStatus is set to null, so it's important that we
            // specifically check for undefined to determine a loading status.
            const preparingForFetch = _.isUndefined(fetchStatus);
            if (preparingForFetch) return status.LOADING;
            else if (rowsEmpty && fetchStatus) return status.LOADING;
            else if (!rowsEmpty) return status.READY;
            else return status.NO_RESULTS;
          }

          return function() {
            const current = {
              rows: $scope.rows,
              fetchStatus: $scope.fetchStatus
            };

            $scope.resultState = pick(
              current.rows,
              prev.rows,
              current.fetchStatus,
              prev.fetchStatus
            );

            prev = current;
          };
        }()));

        $scope.searchSource.onError(function(err) {
          notify.error(err);
        }).catch(notify.fatal);

        function initForTime() {
          return setupVisualization().then($scope.updateTime);
        }

        return Promise.resolve($scope.opts.timefield && initForTime())
          .then(function() {
            init.complete = true;
            $state.replace();
            $scope.$emit('application.load');
          });
      });
  });

  $scope.opts.saveDataSource = function() {
    return $scope.updateDataSource()
      .then(function() {
        savedSearch.columns = $scope.state.columns;
        savedSearch.sort = $scope.state.sort;

        return savedSearch.save()
          .then(function(id) {
            stateMonitor.setInitialState($state.toJSON());
            $scope.kbnTopNav.close('save');

            if (id) {
              notify.info('Saved Data Source "' + savedSearch.title + '"');
              if (savedSearch.id !== $route.current.params.id) {
                kbnUrl.change('/discover/{{id}}', {
                  id: savedSearch.id
                });
              } else {
                // Update defaults so that "reload saved query" functions correctly
                $state.setDefaults(getStateDefaults());
                docTitle.change(savedSearch.lastSavedTitle);
              }
            }
          });
      })
      .catch(notify.error);
  };

  $scope.opts.fetch = $scope.fetch = function() {
    // ignore requests to fetch before the app inits
    if (!init.complete) return;

    $scope.updateTime();

    $scope.updateDataSource()
      .then(setupVisualization)
      .then(function() {
        $state.save();
        return courier.fetch();
      })
      .catch(notify.error);
  };

  $scope.searchSource.onBeginSegmentedFetch(function(segmented) {

    function flushResponseData() {
      $scope.hits = 0;
      $scope.faliures = [];
      $scope.rows = [];
      $scope.fieldCounts = {};
    }

    if (!$scope.rows) flushResponseData();

    const sort = $state.sort;
    const timeField = $scope.indexPattern.timeFieldName;
    const totalSize = $scope.size || $scope.opts.sampleSize;

    /**
     * Basically an emum.
     *
     * opts:
     *   "time" - sorted by the timefield
     *   "non-time" - explicitly sorted by a non-time field, NOT THE SAME AS `sortBy !== "time"`
     *   "implicit" - no sorting set, NOT THE SAME AS "non-time"
     *
     * @type {String}
     */
    const sortBy = (function() {
      if (!_.isArray(sort)) return 'implicit';
      else if (sort[0] === '_score') return 'implicit';
      else if (sort[0] === timeField) return 'time';
      else return 'non-time';
    }());

    let sortFn = null;
    if (sortBy !== 'implicit') {
      sortFn = new HitSortFn(sort[1]);
    }

    $scope.updateTime();
    if (sort[0] === '_score') segmented.setMaxSegments(1);
    segmented.setDirection(sortBy === 'time' ? (sort[1] || 'desc') : 'desc');
    segmented.setSortFn(sortFn);
    segmented.setSize($scope.opts.sampleSize);

    // triggered when the status updated
    segmented.on('status', function(status) {
      $scope.fetchStatus = status;
    });

    segmented.on('first', function() {
      flushResponseData();
    });

    segmented.on('segment', notify.timed('handle each segment', function(resp) {
      if (resp._shards.failed > 0) {
        $scope.failures = _.union($scope.failures, resp._shards.failures);
        $scope.failures = _.uniq($scope.failures, false, function(failure) {
          return failure.index + failure.shard + failure.reason;
        });
      }
    }));

    segmented.on('mergedSegment', function(merged) {
      $scope.mergedEsResp = merged;
      $scope.hits = merged.hits.total;

      const indexPattern = $scope.searchSource.get('index');

      // the merge rows, use a new array to help watchers
      $scope.rows = merged.hits.hits.slice();

      notify.event('flatten hit and count fields', function() {
        let counts = $scope.fieldCounts;

        // if we haven't counted yet, or need a fresh count because we are sorting, reset the counts
        if (!counts || sortFn) counts = $scope.fieldCounts = {};

        $scope.rows.forEach(function(hit) {
          // skip this work if we have already done it
          if (hit.$$_counted) return;

          // when we are sorting results, we need to redo the counts each time because the
          // "top 500" may change with each response, so don't mark this as counted
          if (!sortFn) hit.$$_counted = true;

          const fields = _.keys(indexPattern.flattenHit(hit));
          let n = fields.length;
          let field;
          while (field = fields[--n]) {
            if (counts[field]) counts[field] += 1;
            else counts[field] = 1;
          }
        });
      });
    });

    segmented.on('complete', function() {
      if ($scope.fetchStatus.hitCount === 0) {
        flushResponseData();
      }

      $scope.fetchStatus = null;
    });
  }).catch(notify.fatal);

  $scope.updateTime = function() {
    $scope.timeRange = {
      from: dateMath.parse(timefilter.time.from),
      to: dateMath.parse(timefilter.time.to, true)
    };
  };

  $scope.resetQuery = function() {
    kbnUrl.change('/discover/{{id}}', {
      id: $route.current.params.id
    });
  };

  $scope.newQuery = function() {
    kbnUrl.change('/discover');
  };

  $scope.updateDataSource = Promise.method(function() {
    $scope.searchSource
      .size($scope.opts.sampleSize)
      .sort(getSort($state.sort, $scope.indexPattern))
      .query(!$state.query ? null : $state.query)
      .set('filter', queryFilter.getFilters());

    if (config.get('doc_table:highlight')) {
      $scope.searchSource.highlight({
        pre_tags: [highlightTags.pre],
        post_tags: [highlightTags.post],
        fields: {
          '*': {}
        },
        require_field_match: false,
        fragment_size: 2147483647 // Limit of an integer.
      });
    }
  });

  // TODO: On array fields, negating does not negate the combination, rather all terms
  $scope.filterQuery = function(field, values, operation) {
    $scope.indexPattern.popularizeField(field, 1);
    filterManager.add(field, values, operation, $state.index);
  };

  $scope.toTop = function() {
    $window.scrollTo(0, 0);
  };

  /*
  * Disocver seems to have  pattern of having all controllers
  * in one big file, as against one fiel for individua module
  * Adding all export control options in this one big function
  * just to be conssistent with the pattern
  */


  $scope.exportParams = {};
  $scope.exportParams.exportFileName = 'export.csv';
  $scope.exportParams.defaultExportFileName = 'export.csv';
  $scope.exportParams.exportSize = 500;
  $scope.exportParams.defaultExportSize = 500;
  $scope.exportParams.delimiter = ',';
  $scope.exportParams.quoter = '"';


  //For measuring export latency
  $scope.exportMetric = {};
  $scope.exportMetric.queryLatency = 0;
  $scope.exportMetric.buildLatency = 0;



  //Keep track of ongoing export
  $scope.export = {};
  $scope.export.inProgress = false;

  $scope.export = function() {

    //Disallow export while an export is pending
    if ($scope.export.inProgress) {
      return;
    }

    /*Allow a maximum of 10 seconds for query to return to us;
    * Note: this is just elastic latency bout others as well.
    * cancelResolve is a promise to cancel when timeout occurs
    */
    var cancelResolve = {};
    var cancelTimer = setTimeout(function() {
      cancelResolve();
      $scope.export.inProgress = false;
      $scope.export.timedout = true;
    }, 10000)

    $scope.export.inProgress = true;
    $scope.queryStart = (new Date()).getTime();

    //Keep track of timed out request, show corresponding error
    $scope.export.timedout = false;

    var request = {};
    request.payload = {};


    request.payload.hits = $scope.hits;
    request.payload.selectedFields = $scope.state.columns || [];
    request.payload.size = $scope.exportParams.exportSize;

    //query_string is actually an Object, NOT string
    request.payload.query_string = $scope.state.query.query_string
    request.payload.timestamp = {};

    //Constants for discover export app
    request.payload.timestamp.format = "epoch_millis";
    request.payload.timestamp.gte = moment($scope.timeRange.from._d).valueOf();
    request.payload.timestamp.lte = moment($scope.timeRange.to._d).valueOf();

    /*
    * The main desgin choice is to use our own AJAX transport to elastic.
    *  Discover's built in transport (aka 'fetch') has a lot of side effects.
    *  Also there is a limitation on result set size where in one cannot change 
    *  Discovers fetch result size without affecting Kibana globally.
    * Our own transport sidesteps both of these  problems.
    */

    notify.log('Export: Sending export request ');

    $http.post('../api/kibana/export', request.payload, {

      timeout: new Promise(function(resolve) {
        cancelResolve = resolve;
      })

    }).then((response) => {
      //Assumption is that if data property is present then is of type array;
      notify.log('Export: Received export reply. Starting to build CSV ');
      $scope.queryEnd = (new Date()).getTime();
      $scope.exportMetric.queryLatency = ($scope.queryEnd - $scope.queryStart)/1000.0;

      // Start building export results
      var fAcc = response.data.reduce(function(acc, responseDataElement) {
        request.payload.selectedFields.forEach(function(ele) {
          if (typeof responseDataElement._source != 'undefined') {
            if (acc.length > 0 && acc[acc.length - 1] != '\n') {
              acc += $scope.exportParams.delimiter  + $scope.exportParams.quoter + responseDataElement._source[ele] + $scope.exportParams.quoter;
            } else {
              acc += $scope.exportParams.quoter + responseDataElement._source[ele] + $scope.exportParams.quoter;
            }
          }
        });
        acc += "\n";
        return acc;
      }, "");

      // Using a file save plugin that an elastic Engineer wrote, look in the code for license questions
      var fAccArr = [];
      fAccArr.push(request.payload.selectedFields.join() + "\n");
      fAccArr.push(fAcc);
      var blob = new Blob(fAccArr, {
        //type: 'application/json'
        type: "text/plain;charset=utf-8"
      });
      if ($scope.state.columns.length == 1 && $scope.state.columns[0] == '_source') {
        console.log('Please select at least one field other than _source');
      } else {
        fsaver.saveAs(blob, $scope.exportParams.exportFileName.toString());
      }
      $scope.buildEnd = (new Date()).getTime();
      $scope.exportMetric.buildLatency = ($scope.buildEnd - $scope.queryEnd)/1000.0;
      $scope.export.inProgress = false;
      clearTimeout(cancelTimer);
      cancelTimer = null;
      notify.log('Export: Building CSV complete ');
      

    });
  }

  let loadingVis;

  function setupVisualization() {
    // If we're not setting anything up we need to return an empty promise
    if (!$scope.opts.timefield) return Promise.resolve();
    if (loadingVis) return loadingVis;

    const visStateAggs = [{
      type: 'count',
      schema: 'metric'
    }, {
      type: 'date_histogram',
      schema: 'segment',
      params: {
        field: $scope.opts.timefield,
        interval: $state.interval
      }
    }];

    // we have a vis, just modify the aggs
    if ($scope.vis) {
      const visState = $scope.vis.getEnabledState();
      visState.aggs = visStateAggs;

      $scope.vis.setState(visState);
      return Promise.resolve($scope.vis);
    }

    $scope.vis = new Vis($scope.indexPattern, {
      title: savedSearch.title,
      type: 'histogram',
      params: {
        addLegend: false,
        addTimeMarker: true
      },
      listeners: {
        click: function(e) {
          notify.log(e);
          timefilter.time.from = moment(e.point.x);
          timefilter.time.to = moment(e.point.x + e.data.ordered.interval);
          timefilter.time.mode = 'absolute';
        },
        brush: brushEvent($scope.state)
      },
      aggs: visStateAggs
    });

    $scope.searchSource.aggs(function() {
      $scope.vis.requesting();
      return $scope.vis.aggs.toDsl();
    });

    // stash this promise so that other calls to setupVisualization will have to wait
    loadingVis = new Promise(function(resolve) {
        $scope.$on('ready:vis', function() {
          resolve($scope.vis);
        });
      })
      .finally(function() {
        // clear the loading flag
        loadingVis = null;
      });

    return loadingVis;
  }

  function resolveIndexPatternLoading() {
    const props = $route.current.locals.ip;
    const loaded = props.loaded;
    const stateVal = props.stateVal;
    const stateValFound = props.stateValFound;

    const own = $scope.searchSource.getOwn('index');

    if (own && !stateVal) return own;
    if (stateVal && !stateValFound) {
      const err = '"' + stateVal + '" is not a configured pattern. ';
      if (own) {
        notify.warning(err + ' Using the saved index pattern: "' + own.id + '"');
        return own;
      }

      notify.warning(err + ' Using the default index pattern: "' + loaded.id + '"');
    }
    return loaded;
  }

  init();
};