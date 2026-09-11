/**
 * Points the join page's three actions at the app.
 *
 * The app is normally mounted at /app on this same origin, which is the whole
 * design: a fan who presses "Join as Fan" should never see the address bar
 * change, because a domain change mid-signup reads as being handed to somebody
 * else's website — and this one is about to ask for their face.
 *
 * The hrefs in the HTML already say /app, so the page works with scripting off
 * and this only re-points them if the deployment puts the app elsewhere.
 */
(function () {
  'use strict';

  var links = window.__REXELL_LINKS__ || {};
  var base = String(links.fan || '/app').replace(/\/+$/, '');

  var intents = { start: '#start', browse: '#browse', signin: '#signin' };

  Object.keys(intents).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('href', base + '/' + intents[id]);
  });

  // A visitor who already has an ID on this device does not need the pitch.
  // Sending them straight on would be presumptuous — they may have clicked to
  // read it — so the primary action just changes what it promises.
  try {
    if (localStorage.getItem('rexell.fan.enrolled') === 'true') {
      var start = document.getElementById('start');
      if (start) {
        start.firstChild.nodeValue = '\n        Open my tickets\n        ';
        start.setAttribute('href', base + '/');
      }
    }
  } catch (e) {
    // Storage can throw in a private window. The page is correct without it.
  }
})();
