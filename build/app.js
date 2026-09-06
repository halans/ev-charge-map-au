/* ==========================================================================
   EV Chargers AU — page application.

   Note what this file does NOT do: it does not filter, sort, or match sites.
   Every query goes through the core search engine that was inlined at build
   time (`__evmapRequire('search')`), which is byte-identical to the module the
   CLI and HTTP API use. That is the single-source-of-truth guarantee.
   ========================================================================== */
'use strict';

(function () {
  var search = __evmapRequire('search');
  var geo = __evmapRequire('geo');

  var SITES = window.EVMAP_SITES || [];
  var META = window.EVMAP_META || {};

  /* ---------------- state ---------------- */

  var state = {
    text: '',
    minPowerKw: null,
    connector: null,
    state: null,
    operator: null,
    corroboratedOnly: false,
    includePlanned: false,
    includeApproximate: false,
    centre: null, // {lat,lng} from geolocation
    selectedId: null,
    lastResults: [],
  };

  var el = {};
  ['q','locate','filters','filters-toggle','filters-reset','filters-done','filter-count',
   'f-power','f-connector','f-state','f-operator','f-corroborated','f-planned','f-approximate',
   'map','fallback-map','panel','panel-handle','results','detail','result-count',
   'attribution','freshness','about','about-toggle','about-intro','about-sources','about-licence',
   'map-hint','toast','legend-toggle','legend']
    .forEach(function (id) { el[id] = document.getElementById(id); });

  /* ---------------- map ---------------- */

  var map = null;
  var markerLayer = null;
  var markers = {};       // id -> marker
  var tilesFailed = false;
  var CLUSTER_PIXEL_RADIUS = 70; // target on-screen radius for a grouped cell, in CSS px
  var CLUSTER_MIN_SITES = 40;    // below this, bucketing has nothing worth merging anyway

  function initMap() {
    map = L.map('map', {
      center: [-25.6, 134.4],
      zoom: 4,
      zoomControl: true,
      preferCanvas: true,   // 3,000 markers as DOM elements is far too slow
      worldCopyJump: false,
    });

    var tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      // OSM tile usage policy requires identifying attribution; we are also
      // obliged to attribute OSM as a data source under ODbL.
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
    });

    // If tiles cannot load (offline, blocked), fall back to a canvas plot so
    // the page stays usable rather than showing an empty grey rectangle.
    var tileErrors = 0;
    tiles.on('tileerror', function () {
      tileErrors++;
      if (tileErrors > 6 && !tilesFailed) {
        tilesFailed = true;
        enableFallbackMap();
      }
    });
    tiles.addTo(map);

    markerLayer = L.layerGroup().addTo(map);
    map.on('moveend zoomend', function () { render({ fromMap: true }); });
  }

  function speedClass(site) {
    if (site.positionPrecision === 'geocoded_locality') return 'approximate';
    if (site.status === 'planned') return 'planned';
    return site.speedBand || 'unknown';
  }

  /**
   * Render markers for the current result set. Uses circle markers on a canvas
   * renderer; sites that fall within CLUSTER_PIXEL_RADIUS screen-pixels of
   * each other, at whatever the current zoom happens to be, are grouped into
   * one numbered cluster bubble rather than a scatter of overlapping pins —
   * no zoom cutoff and no clustering dependency required.
   */
  function renderMarkers(sites) {
    markerLayer.clearLayers();
    markers = {};

    var zoom = map.getZoom();
    // Each display item is { site, count } — count is 1 for an ungrouped site.
    var display = sites.map(function (s) { return { site: s, count: 1 }; });

    if (sites.length > CLUSTER_MIN_SITES) {
      // Bucket into one entry per grid cell, keeping the highest-powered
      // site as the representative (so fast chargers still surface their
      // own detail when the cluster is opened) and counting the rest.
      //
      // Cell size is derived from the map's actual ground resolution at the
      // current zoom (standard Web Mercator metres-per-pixel, adjusted for
      // latitude), targeting a constant ~CLUSTER_PIXEL_RADIUS on screen —
      // the same rule at every zoom, not just below some cutoff. Clustering
      // used to hard-stop at zoom 8, on the assumption that "zoomed in"
      // meant "spread out", but a dense CBD at zoom 12+ can still have
      // dozens of sites within a few screen-pixels of each other (multiple
      // stalls at one car park, several networks at one shopping centre).
      // The pixel-radius rule already leaves genuinely spread-out markers
      // alone at any zoom, so there's no need to disable it by zoom at all.
      var metresPerPixel = 156543.03392 * Math.cos(map.getCenter().lat * Math.PI / 180) / Math.pow(2, zoom);
      var cellM = metresPerPixel * CLUSTER_PIXEL_RADIUS;
      var buckets = {};
      sites.forEach(function (s) {
        var key = geo.cellKey(s.lat, s.lng, cellM);
        var b = buckets[key];
        if (!b) {
          buckets[key] = { site: s, count: 1 };
        } else {
          b.count++;
          if ((s.maxPowerKw || 0) > (b.site.maxPowerKw || 0)) b.site = s;
        }
      });
      display = Object.keys(buckets).map(function (k) { return buckets[k]; });
    }

    // Only worth mentioning when grouping actually reduced what's on
    // screen — with real counts on every bubble, nothing is hidden, so
    // this is purely about the list panel showing a different slice.
    var thinned = display.length < sites.length;

    // The list panel shows a separately-sliced subset of the same query
    // (see LIST_LIMIT), so at low zoom the pins on screen and the rows in
    // the list are two different views of the result set. Say so, rather
    // than letting the mismatch look like a bug.
    updateMapHint(thinned, display.length, sites.length);

    var colours = {
      ultra: '#b06cf5', rapid: '#35d07f', fast: '#4aa8f0', medium: '#4aa8f0',
      // Darker than the app's dim-grey chrome (#8b94a5): that colour reads at
      // roughly 2.7:1 contrast against the light OSM basemap, well under the
      // 3:1 minimum for graphical objects, so slow/unknown-power sites (the
      // most common category) all but disappeared once zoomed into the tiles.
      slow: '#6b7280', trickle: '#6b7280', unknown: '#6b7280', planned: '#f0a92e',
      approximate: '#6b3fb5',
    };

    display.forEach(function (item) {
      var s = item.site;

      if (item.count > 1) {
        var size = item.count >= 100 ? 34 : item.count >= 20 ? 28 : 24;
        var icon = L.divIcon({
          className: '',
          html: '<div class="cluster" style="width:' + size + 'px;height:' + size + 'px;font-size:' +
                (item.count >= 100 ? 11 : 12) + 'px">' + item.count + '</div>',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
        var cluster = L.marker([s.lat, s.lng], { icon: icon, keyboard: false });
        cluster.on('click', function () {
          map.setView([s.lat, s.lng], Math.max(8, map.getZoom() + 2), { animate: true });
        });
        cluster.bindTooltip(
          item.count + ' charging sites in this area — click to zoom in',
          { direction: 'top', offset: [0, -size / 2] }
        );
        cluster.addTo(markerLayer);
        return;
      }

      var cls = speedClass(s);
      var selected = s.id === state.selectedId;
      // A town-level record is drawn as a large hollow ring rather than a pin,
      // so it never reads as a precise location.
      var approx = cls === 'approximate';
      var marker = L.circleMarker([s.lat, s.lng], {
        // Every band gets the same base size — a slow/unknown-power charger
        // isn't a smaller data point than a fast one, and shrinking it on
        // top of a low-contrast grey fill made it doubly hard to spot.
        radius: selected ? 11 : approx ? 10 : 6,
        color: selected ? '#35d07f' : approx ? '#6b3fb5' : 'rgba(255,255,255,0.85)',
        weight: selected ? 3 : approx ? 2 : 1.5,
        dashArray: approx ? '3,3' : null,
        fillColor: colours[cls] || colours.unknown,
        fillOpacity: approx ? 0.12 : cls === 'planned' ? 0.35 : 0.95,
      });
      marker.on('click', function () { selectSite(s.id, { pan: false }); });
      marker.bindTooltip(
        (s.displayName || s.name || 'Unnamed site') + (s.maxPowerKw ? ' · ' + s.maxPowerKw + 'kW' : '') +
          (approx ? ' · approximate (town-level)' : ''),
        { direction: 'top', offset: [0, -6] }
      );
      marker.addTo(markerLayer);
      markers[s.id] = marker;
    });

    if (tilesFailed) drawFallbackMap(display.map(function (item) { return item.site; }));
  }

  function updateMapHint(thinned, shown, total) {
    if (!thinned) {
      el['map-hint'].hidden = true;
      return;
    }
    el['map-hint'].hidden = false;
    el['map-hint'].textContent =
      'Showing ' + shown.toLocaleString('en-AU') + ' of ' + total.toLocaleString('en-AU') +
      ' sites at this zoom — zoom in to see the rest';
  }

  /* ---------------- toast (non-blocking notices) ---------------- */

  var toastTimer = null;
  function showToast(message) {
    el['toast'].textContent = message;
    el['toast'].hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el['toast'].hidden = true; }, 6000);
  }

  /* ---------------- offline canvas fallback ---------------- */

  function enableFallbackMap() {
    el['map'].hidden = true;
    el['fallback-map'].hidden = false;
    drawFallbackMap(state.lastResults);
  }

  /**
   * Minimal equirectangular scatter plot of the results, used when map tiles
   * are unreachable. No basemap, but it still conveys distribution and keeps
   * the app functional offline.
   */
  function drawFallbackMap(sites) {
    var canvas = el['fallback-map'];
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);

    var bbox = geo.AU_BBOX;
    var pad = 16;
    var sx = (rect.width - pad * 2) / (bbox.maxLng - bbox.minLng);
    var sy = (rect.height - pad * 2) / (bbox.maxLat - bbox.minLat);
    var scale = Math.min(sx, sy);

    function project(lat, lng) {
      return {
        x: pad + (lng - bbox.minLng) * scale,
        y: rect.height - pad - (lat - bbox.minLat) * scale,
      };
    }

    ctx.fillStyle = 'rgba(140,150,170,0.10)';
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(150,160,180,0.9)';
    ctx.fillText('Map tiles unavailable — offline plot of ' + sites.length + ' sites', pad, pad + 4);

    var colours = {
      ultra: '#b06cf5', rapid: '#35d07f', fast: '#4aa8f0', medium: '#4aa8f0',
      // Darker than the app's dim-grey chrome (#8b94a5): that colour reads at
      // roughly 2.7:1 contrast against the light OSM basemap, well under the
      // 3:1 minimum for graphical objects, so slow/unknown-power sites (the
      // most common category) all but disappeared once zoomed into the tiles.
      slow: '#6b7280', trickle: '#6b7280', unknown: '#6b7280', planned: '#f0a92e',
    };
    (sites || []).forEach(function (s) {
      var p = project(s.lat, s.lng);
      ctx.beginPath();
      ctx.arc(p.x, p.y, s.id === state.selectedId ? 6 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = colours[speedClass(s)] || colours.unknown;
      ctx.fill();
    });
  }

  /* ---------------- query construction ---------------- */

  /**
   * Build the query object handed to the core engine.
   * `viewportOnly` restricts to the current map bounds, which is what makes
   * the list feel connected to the map.
   */
  function buildQuery(opts) {
    opts = opts || {};
    var q = {
      text: state.text || null,
      minPowerKw: state.minPowerKw,
      connectors: state.connector ? [state.connector] : null,
      states: state.state ? [state.state] : null,
      operators: state.operator ? [state.operator] : null,
      minSources: state.corroboratedOnly ? 2 : null,
      includePlanned: state.includePlanned,
      includeApproximate: state.includeApproximate,
      limit: null, // unbounded for the map; the list is sliced separately
    };

    if (state.centre) {
      q.lat = state.centre.lat;
      q.lng = state.centre.lng;
    }

    // Viewport filter: only when the user has zoomed in and is not running a
    // text search (a text search should find things off-screen).
    if (opts.viewportOnly && map && !state.text && map.getZoom() >= 7) {
      var b = map.getBounds();
      q.bbox = {
        minLat: b.getSouth(), maxLat: b.getNorth(),
        minLng: b.getWest(),  maxLng: b.getEast(),
      };
    }
    return q;
  }

  /* ---------------- rendering ---------------- */

  var LIST_LIMIT = 120;

  function render(opts) {
    opts = opts || {};
    var result;
    try {
      result = search.query(SITES, buildQuery({ viewportOnly: true }));
    } catch (err) {
      el['results'].innerHTML = '<div class="empty">Query error: ' + escapeHtml(err.message) + '</div>';
      return;
    }

    state.lastResults = result.results;
    renderMarkers(result.results);
    renderList(result);
    renderFilterCount();
  }

  function renderList(result) {
    var sites = result.results.slice(0, LIST_LIMIT);
    el['result-count'].textContent =
      result.total === 0
        ? 'No sites match'
        : result.total + ' site' + (result.total === 1 ? '' : 's') +
          (result.total > sites.length ? ' — showing ' + sites.length : '') +
          (state.centre ? ' · nearest first' : '');

    if (!sites.length) {
      el['results'].innerHTML =
        '<div class="empty">No charging sites match these filters.<br>' +
        'Try widening the power filter, clearing the search box, or zooming out.</div>';
      return;
    }

    var html = sites.map(function (s) {
      var cls = speedClass(s);
      var badges = [];
      if (s.maxPowerKw) {
        badges.push('<span class="badge ' + cls + '">' + s.maxPowerKw + ' kW</span>');
      } else {
        badges.push('<span class="badge">power unknown</span>');
      }
      if (s.status === 'planned') badges.push('<span class="badge planned">not yet built</span>');
      if (s.positionPrecision === 'geocoded_locality') {
        badges.push('<span class="badge approx">town-level position</span>');
      }
      if (s.sourceCount > 1) badges.push('<span class="badge multi">' + s.sourceCount + ' sources</span>');
      if (s.conflicts && s.conflicts.length) badges.push('<span class="badge conflict">sources differ</span>');

      var conns = (s.connectors || []).map(function (c) { return c.standard; }).join(' · ');

      return '' +
        '<button class="result" role="listitem" data-id="' + escapeAttr(s.id) + '"' +
        (s.id === state.selectedId ? ' aria-current="true"' : '') + '>' +
          '<span class="result-top">' +
            '<span class="result-name">' + escapeHtml(s.displayName || s.name || 'Unnamed site') + '</span>' +
            (s.distanceKm !== undefined
              ? '<span class="result-dist">' + s.distanceKm + ' km</span>' : '') +
          '</span>' +
          '<span class="result-meta">' +
            badges.join('') +
            '<span>' + escapeHtml(s.operator || 'unknown operator') + '</span>' +
            (conns ? '<span>' + escapeHtml(conns) + '</span>' : '') +
            (s.suburb ? '<span>' + escapeHtml(s.suburb) + (s.state ? ', ' + s.state : '') + '</span>' : '') +
          '</span>' +
        '</button>';
    }).join('');

    el['results'].innerHTML = html;
  }

  function renderFilterCount() {
    var n = 0;
    if (state.minPowerKw) n++;
    if (state.connector) n++;
    if (state.state) n++;
    if (state.operator) n++;
    if (state.corroboratedOnly) n++;
    if (state.includePlanned) n++;
    if (state.includeApproximate) n++;
    if (n > 0) {
      el['filter-count'].hidden = false;
      el['filter-count'].textContent = String(n);
    } else {
      el['filter-count'].hidden = true;
    }
  }

  /* ---------------- detail view ---------------- */

  var SOURCE_LABELS = {};
  (META.sources || []).forEach(function (s) { SOURCE_LABELS[s.sourceId] = s; });

  function selectSite(id, opts) {
    opts = opts || {};
    state.selectedId = id;
    // Use the shared engine's lookup rather than filtering SITES here, so
    // all site access goes through core (see test/equivalence.test.js).
    var site = search.byId(SITES, id);
    if (!site) return;

    if (opts.pan !== false && map && !tilesFailed) {
      map.setView([site.lat, site.lng], Math.max(map.getZoom(), 14), { animate: true });
    }
    renderDetail(site);
    renderMarkers(state.lastResults);
    setPanelState('expanded');
  }

  function renderDetail(s) {
    var srcRows = Object.keys(s.provenance || {}).map(function (field) {
      var sid = s.provenance[field];
      var label = SOURCE_LABELS[sid] ? SOURCE_LABELS[sid].name : sid;
      var budget = (META.freshnessBudgetDays || {})[field];
      return '<div class="prov-row"><span>' + escapeHtml(field) + '</span>' +
             '<code>' + escapeHtml(label) + (budget ? ' · ' + budget + 'd budget' : '') + '</code></div>';
    }).join('');

    var conns = (s.connectors || []).length
      ? '<div class="conn-list">' + s.connectors.map(function (c) {
          return '<div class="conn"><strong>' + escapeHtml(prettyConnector(c.standard)) + '</strong>' +
                 '<span>' + (c.count ? c.count + ' plug' + (c.count === 1 ? '' : 's') : 'count unknown') +
                 (c.powerKw ? ' · ' + c.powerKw + ' kW' : '') + '</span></div>';
        }).join('') + '</div>'
      : '<p class="notice info">No connector detail is published for this site in open data.</p>';

    var warnings = [];
    if (s.positionPrecision === 'geocoded_locality') {
      warnings.push(
        '<p class="notice"><strong>This is not a charger location.</strong> The source ' +
          'publishes only a town name, so the marker sits at the centre of ' +
          escapeHtml(s.suburb || 'the town') + ' and the charger may be several kilometres away. ' +
          'Use it to know a funded charger exists here, not to navigate to it.</p>'
      );
    }
    if (s.status === 'planned') {
      warnings.push('<p class="notice"><strong>Not yet built.</strong> This site appears in a government rollout dataset as planned or under construction. Do not rely on it.</p>');
    }
    if (s.conflicts && s.conflicts.length) {
      warnings.push('<p class="notice"><strong>Sources disagree</strong> on: ' +
        escapeHtml(s.conflicts.join(', ')) + '. The value shown is from the most trusted source for each field.</p>');
    }
    if (s.spatialSpreadM > 60) {
      warnings.push('<p class="notice">Sources place this site up to <strong>' + s.spatialSpreadM +
        ' m</strong> apart, so the pin may be slightly off.</p>');
    }
    if (s.sourceCount === 1) {
      warnings.push('<p class="notice info">Only one open source lists this site, so it is uncorroborated.</p>');
    }

    var links = (s.sourceUrls || []).map(function (u) {
      var label = u.indexOf('openstreetmap.org') !== -1 ? 'View on OpenStreetMap'
                : u.indexOf('transport.nsw') !== -1 ? 'TfNSW dataset'
                : u.indexOf('data.vic') !== -1 ? 'Victorian dataset'
                : u.indexOf('data.gov.au') !== -1 ? 'data.gov.au dataset'
                : 'Source record';
      return '<a href="' + escapeAttr(u) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    }).join('');

    el['detail'].innerHTML = '' +
      '<div class="detail-head">' +
        '<button class="ghost small detail-back" id="detail-back">← Back to results</button>' +
        '<h3 class="detail-title">' + escapeHtml(s.displayName || s.name || 'Unnamed site') + '</h3>' +
        '<div class="detail-sub">' + escapeHtml(s.operator || 'Unknown operator') +
          (s.address ? ' · ' + escapeHtml(s.address) : '') + '</div>' +
      '</div>' +
      (warnings.length ? '<div class="detail-section">' + warnings.join('') + '</div>' : '') +
      '<div class="detail-section"><h4>Charging</h4>' + conns +
        '<dl class="kv" style="margin-top:10px">' +
          '<dt>Peak power</dt><dd>' + (s.maxPowerKw ? s.maxPowerKw + ' kW (' + s.speedBand + ')' : 'unknown') + '</dd>' +
          '<dt>Plugs</dt><dd>' + (s.plugCount != null ? s.plugCount : 'unknown') + '</dd>' +
          '<dt>Access</dt><dd>' + escapeHtml(s.access === 'unknown' ? 'not published' : s.access) + '</dd>' +
          '<dt>Cost</dt><dd>' + (s.fee === true ? 'paid' : s.fee === false ? 'free' : 'not published') + '</dd>' +
        '</dl>' +
      '</div>' +
      '<div class="detail-section"><h4>Location</h4>' +
        '<dl class="kv">' +
          '<dt>Coordinates</dt><dd>' + s.lat.toFixed(6) + ', ' + s.lng.toFixed(6) + '</dd>' +
          '<dt>State</dt><dd>' + escapeHtml(s.state || 'unknown') + '</dd>' +
          '<dt>Postcode</dt><dd>' + escapeHtml(s.postcode || 'unknown') + '</dd>' +
        '</dl>' +
        '<div class="detail-links" style="margin-top:10px">' +
          '<a href="https://www.google.com/maps/dir/?api=1&destination=' + s.lat + ',' + s.lng +
          '" target="_blank" rel="noopener noreferrer">Directions</a>' + links +
        '</div>' +
      '</div>' +
      '<details class="detail-section"><summary>Where this record came from</summary>' +
        '<div class="prov">' + (srcRows || '<em>no provenance recorded</em>') + '</div>' +
        '<dl class="kv" style="margin-top:10px">' +
          '<dt>Position</dt><dd>' + escapeHtml(prettyPrecision(s.positionPrecision)) + '</dd>' +
          '<dt>Confidence</dt><dd>' + s.confidence + ' / 1.0</dd>' +
          '<dt>Sources</dt><dd>' + escapeHtml((s.sources || []).join(', ')) + '</dd>' +
          '<dt>Last fetched</dt><dd>' + escapeHtml(formatDate(s.fetchedAt)) + '</dd>' +
        '</dl>' +
      '</details>' +
      '<div class="detail-section"><h4>Site id</h4><code style="font-size:11px">' +
        escapeHtml(s.id) + '</code></div>';

    el['results'].hidden = true;
    el['detail'].hidden = false;

    var back = document.getElementById('detail-back');
    if (back) back.addEventListener('click', closeDetail);
  }

  function closeDetail() {
    state.selectedId = null;
    el['detail'].hidden = true;
    el['results'].hidden = false;
    render();
  }

  function prettyPrecision(p) {
    var map_ = {
      surveyed: 'published coordinates (accurate to metres)',
      geocoded_address: 'geocoded from a street address (±100 m)',
      geocoded_locality: 'town centroid only — NOT the charger position (±km)',
    };
    return map_[p] || 'unknown';
  }

  function prettyConnector(std) {
    var map_ = {
      CCS2: 'CCS2 (Type 2 Combo)', CCS1: 'CCS1', CHAdeMO: 'CHAdeMO',
      Type2: 'Type 2 (AC)', Type1: 'Type 1 (AC)',
      TeslaProprietary: 'Tesla proprietary',
      ACUnspecified: 'AC (standard not published)',
      DCUnspecified: 'DC (standard not published)',
    };
    return map_[std] || std;
  }

  /* ---------------- bottom sheet ---------------- */

  function setPanelState(next) {
    el['panel'].setAttribute('data-state', next);
  }

  function initSheet() {
    setPanelState('peek');

    el['panel-handle'].addEventListener('click', function () {
      var cur = el['panel'].getAttribute('data-state');
      setPanelState(cur === 'expanded' ? 'peek' : 'expanded');
    });
    el['panel-handle'].addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        el['panel-handle'].click();
      }
    });

    // Drag the sheet with a pointer/touch gesture.
    var startY = null;
    var startState = null;
    el['panel-handle'].addEventListener('pointerdown', function (e) {
      startY = e.clientY;
      startState = el['panel'].getAttribute('data-state');
      el['panel-handle'].setPointerCapture(e.pointerId);
    });
    el['panel-handle'].addEventListener('pointerup', function (e) {
      if (startY === null) return;
      var dy = e.clientY - startY;
      if (Math.abs(dy) > 28) {
        setPanelState(dy < 0 ? 'expanded' : startState === 'expanded' ? 'peek' : 'hidden');
      }
      startY = null;
    });
  }

  /* ---------------- controls ---------------- */

  function initControls() {
    // Populate the operator select with the 40 most common operators
    // (otherwise the long tail of one-off names swamps the list), listed
    // alphabetically so they're easy to scan rather than ranked by count.
    var counts = {};
    SITES.forEach(function (s) {
      if (s.operator) counts[s.operator] = (counts[s.operator] || 0) + 1;
    });
    Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .slice(0, 40)
      .sort(function (a, b) { return a.localeCompare(b); })
      .forEach(function (op) {
        var o = document.createElement('option');
        o.value = op;
        o.textContent = op + ' (' + counts[op] + ')';
        el['f-operator'].appendChild(o);
      });

    var debounce = null;
    el['q'].addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () {
        state.text = el['q'].value.trim();
        if (state.selectedId) closeDetail(); else render();
        if (state.text) setPanelState('expanded');
      }, 160);
    });

    el['filters-toggle'].addEventListener('click', function () {
      var hidden = el['filters'].hidden;
      el['filters'].hidden = !hidden;
      el['filters-toggle'].setAttribute('aria-expanded', String(hidden));
    });
    el['filters-done'].addEventListener('click', function () {
      el['filters'].hidden = true;
      el['filters-toggle'].setAttribute('aria-expanded', 'false');
      setPanelState('expanded');
    });

    el['f-power'].addEventListener('change', function () {
      state.minPowerKw = this.value ? Number(this.value) : null;
      render();
    });
    el['f-connector'].addEventListener('change', function () {
      state.connector = this.value || null;
      render();
    });
    el['f-state'].addEventListener('change', function () {
      state.state = this.value || null;
      render();
      if (state.state) fitToState(state.state);
    });
    el['f-operator'].addEventListener('change', function () {
      state.operator = this.value || null;
      render();
    });
    el['f-corroborated'].addEventListener('change', function () {
      state.corroboratedOnly = this.checked;
      render();
    });
    el['f-planned'].addEventListener('change', function () {
      state.includePlanned = this.checked;
      render();
    });
    el['f-approximate'].addEventListener('change', function () {
      state.includeApproximate = this.checked;
      render();
    });

    el['filters-reset'].addEventListener('click', function () {
      state.minPowerKw = null; state.connector = null; state.state = null;
      state.operator = null; state.corroboratedOnly = false; state.includePlanned = false;
      state.includeApproximate = false;
      el['f-power'].value = ''; el['f-connector'].value = ''; el['f-state'].value = '';
      el['f-operator'].value = ''; el['f-corroborated'].checked = false; el['f-planned'].checked = false;
      el['f-approximate'].checked = false;
      render();
    });

    el['results'].addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.result') : null;
      if (btn && btn.dataset.id) selectSite(btn.dataset.id);
    });

    el['locate'].addEventListener('click', function () {
      if (!navigator.geolocation) {
        showToast('This browser does not expose location services.');
        return;
      }
      el['locate'].dataset.active = '1';
      navigator.geolocation.getCurrentPosition(
        function (pos) {
          state.centre = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          if (map && !tilesFailed) map.setView([state.centre.lat, state.centre.lng], 11);
          render();
          setPanelState('expanded');
        },
        function (err) {
          el['locate'].dataset.active = '';
          showToast('Could not get your location: ' + err.message);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
      );
    });

    el['toast'].addEventListener('click', function () {
      el['toast'].hidden = true;
      clearTimeout(toastTimer);
    });

    el['legend-toggle'].addEventListener('click', function () {
      var hidden = el['legend'].hidden;
      el['legend'].hidden = !hidden;
      el['legend-toggle'].setAttribute('aria-expanded', String(hidden));
    });

    el['about-toggle'].addEventListener('click', function () {
      if (typeof el['about'].showModal === 'function') el['about'].showModal();
      else el['about'].setAttribute('open', '');
    });

    window.addEventListener('resize', function () {
      if (tilesFailed) drawFallbackMap(state.lastResults);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && state.selectedId) closeDetail();
      if (e.key === '/' && document.activeElement !== el['q']) {
        e.preventDefault();
        el['q'].focus();
      }
    });
  }

  var STATE_CENTRES = {
    NSW: [-32.5, 147.0, 6], VIC: [-36.9, 144.5, 6], QLD: [-21.5, 145.0, 5],
    SA: [-30.5, 135.5, 5],  WA: [-26.0, 121.0, 5],  TAS: [-42.0, 146.6, 7],
    NT: [-19.5, 133.4, 5],  ACT: [-35.49, 149.05, 10],
  };
  function fitToState(code) {
    var c = STATE_CENTRES[code];
    if (c && map && !tilesFailed) map.setView([c[0], c[1]], c[2]);
  }

  /* ---------------- about dialog + footer ---------------- */

  function initAbout() {
    var total = (META.counts && META.counts.sites) || SITES.length;
    el['about-intro'].textContent =
      'This map shows ' + total.toLocaleString('en-AU') + ' public charging sites reconciled from ' +
      (META.sources || []).length + ' openly-licensed datasets. Records describing the same ' +
      'physical site are matched and merged, and every field records which source it came from.';

    el['about-sources'].innerHTML = (META.sources || []).map(function (s) {
      return '<div class="src-card">' +
        '<h4>' + escapeHtml(s.name) + '</h4>' +
        '<p>' + escapeHtml(s.jurisdiction) + ' · ' + (s.recordCount || 0).toLocaleString('en-AU') +
          ' records · refreshed ' + escapeHtml(s.recommendedRefresh || 'periodically') + '</p>' +
        '<p>' + escapeHtml(s.attribution) + ' — <a href="' + escapeAttr(s.licenceUrl) +
          '" target="_blank" rel="noopener noreferrer">' + escapeHtml(s.licence) + '</a></p>' +
        (s.coverageCaveat ? '<p class="caveat">' + escapeHtml(s.coverageCaveat) + '</p>' : '') +
      '</div>';
    }).join('');

    el['about-licence'].innerHTML =
      escapeHtml((META.licence && META.licence.effective) || 'see sources') + '. ' +
      escapeHtml((META.licence && META.licence.reason) || '');

    var generated = formatDate(META.generatedAt);
    el['freshness'].textContent = 'Data compiled ' + generated + ' · no live availability';
  }

  /* ---------------- helpers ---------------- */

  function escapeHtml(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(v) { return escapeHtml(v); }

  function formatDate(iso) {
    if (!iso) return 'unknown';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'unknown';
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ---------------- boot ---------------- */

  function boot() {
    if (!SITES.length) {
      el['results'].innerHTML =
        '<div class="empty">No dataset was embedded in this page.<br>' +
        'Run <code>evmap ingest</code> then <code>evmap build</code>.</div>';
      el['result-count'].textContent = 'No data';
      return;
    }
    initMap();
    initSheet();
    initControls();
    initAbout();
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
