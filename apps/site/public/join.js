/**
 * Sends the marketing site's calls to action into the product.
 *
 * The site is a built React bundle with no source in this repository, so this
 * sits alongside it rather than inside it. Hand-editing 469KB of minified
 * output would be a change nobody could review, repeat, or undo.
 *
 * Every "Join as Fan" and "Join as Organizer" on the page routes to
 * `/waitlist?type=fan` or `?type=organizer` — six of them, across the hero,
 * the audience cards and the footer. Rather than find six buttons by their
 * text, this intercepts the navigation itself, which catches all six and any
 * the site grows later.
 *
 * The waitlist still exists for anybody who reaches it without a type. The
 * product is not finished enough to have nothing to collect.
 */
(function () {
  'use strict';

  var links = window.__REXELL_LINKS__ || {};

  /*
   * Where each call to action lands.
   *
   * Not the app's front door in either case — the visitor has already chosen,
   * and showing them a second landing page to choose again is a step that
   * exists only because of how the software is arranged. The hash says which
   * journey they picked and the app opens on it.
   */
  var DESTINATIONS = {
    fan: links.fan ? links.fan.replace(/\/+$/, '') + '/#start' : null,
    organizer: links.console ? links.console.replace(/\/+$/, '') + '/#join' : null,
  };

  function destinationFor(href) {
    var url;
    try {
      url = new URL(href, location.origin);
    } catch (e) {
      return null;
    }
    if (url.pathname.replace(/\/+$/, '') !== '/waitlist') return null;
    return DESTINATIONS[url.searchParams.get('type')] || null;
  }

  /*
   * React Router navigates by calling history.pushState, so wrapping it
   * catches the click regardless of which button was pressed or how the
   * bundle is structured. Patching before the bundle would be tidier, but the
   * router holds its own reference from the moment it initialises, so this
   * has to wrap the same function object the router will call — which it
   * does, because both reference window.history.
   */
  function wrap(name) {
    var original = history[name];
    history[name] = function (state, title, url) {
      var destination = url == null ? null : destinationFor(String(url));
      if (destination) {
        // Replace rather than assign: the waitlist URL was never really
        // visited, and leaving it in the back stack means Back from the app
        // bounces straight forward again.
        location.replace(destination);
        return;
      }
      return original.apply(this, arguments);
    };
  }

  wrap('pushState');
  wrap('replaceState');

  // A link pasted or bookmarked straight at /waitlist?type=fan, which is the
  // form these URLs took for as long as the waitlist was the destination.
  var onLoad = destinationFor(location.href);
  if (onLoad) location.replace(onLoad);
})();
