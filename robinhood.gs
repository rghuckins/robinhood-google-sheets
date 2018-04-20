/**
 * Google Apps Script custom functions that retrieve stock and options data from
 * the Robinhood API and return data in a tabular format for use in Google Sheets.
 *
 * Replace `robinhoodUsername` and `robinhoodPassword` with your own Robinhood credentials.
 */

var robinhoodUsername = '<redacted>';
var robinhoodPassword = '<redacted>';

var robinhoodApiBaseUrl = 'https://api.robinhood.com';
var robinhoodApiUriMap = {
  accounts: '/accounts/',
  achTransfers: '/ach/transfers/',
  dividends: '/dividends/',
  documents: '/documents/',
  marketData: '/marketdata/options/?instruments=',
  optionsOrders: '/options/orders/',
  optionsPositions: '/options/positions/',
  orders: '/orders/',
  portfolios: '/portfolios/',
  positions: '/positions/',
  watchlist: '/watchlists/Default/'
};

/**
 * Get a "classic" Robinhood auth token using your username and password.
 */
function getClassicToken_() {
  var url = robinhoodApiBaseUrl + '/api-token-auth/';
  var payload = {
    'username': robinhoodUsername,
    'password': robinhoodPassword
  };
  var options = {
    'method': 'post',
    'payload': payload,
    'muteHttpExceptions': true
  };
  var response = UrlFetchApp.fetch(url, options);
  var responseJson = JSON.parse(response.getContentText());
  var classicToken = responseJson.token;
  return classicToken;
}

/**
 * While authenticated with a "classic" token, POST to Robinhood's "migrate_token"
 * endpoint to get a short-lived OAuth2 access token and expires_in value.
 */
function getOAuthMigrateTokenResponse_(classicToken) {
  var url = robinhoodApiBaseUrl + '/oauth2/migrate_token/';
  var options = {
    'method': 'post',
    'muteHttpExceptions': true,
    'headers': {
      'Authorization': 'Token ' + classicToken
    }
  };
  var response = UrlFetchApp.fetch(url, options);
  var responseJson = JSON.parse(response.getContentText());
  return responseJson;
}

/**
 * Get an OAuth2 short-lived access token from the script cache, or fetch
 * from the Robinhood API and add the token to the cache.
 */
function getOAuthToken_() {
  var cache = CacheService.getScriptCache();
  var accessToken = cache.get('accessToken');
  if (accessToken) {
    return accessToken;
  }
  var classicToken = getClassicToken_();
  var responseJson = getOAuthMigrateTokenResponse_(classicToken);
  var expiresIn = responseJson.expires_in;
  accessToken = responseJson.access_token;
  cache.put('accessToken', accessToken, expiresIn);
  return accessToken;
}

/**
 * Robinhood API client.
 *
 * If the Robinhood API is made public, this client will
 * handle the OAuth2 dance and refresh token flow appropriately.
 */
function apiClient_() {
  this.get = function(url) {
    var options = {
      'method': 'get',
      'muteHttpExceptions': true,
      'headers': {
        'Authorization': 'Bearer ' + getOAuthToken_()
      }
    };
    try {
      var response = UrlFetchApp.fetch(url, options);
    } catch (err) {
      Utilities.sleep(3000);
      var response = UrlFetchApp.fetch(url, options);
      // Try again after 3 seconds. If sleeping doesn't help, don't catch the error
    }
    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();
    if (responseCode !== 200) {
      throw 'Robinhood API request failed. ' + responseCode + ': ' + responseText;
    }
    var responseJson = JSON.parse(responseText);
    return responseJson;
  };

  this.pagedGet = function(url) {
    var responseJson = this.get(url);
    var results = responseJson.results;
    var nextUrl = responseJson.next;
    while (nextUrl) {
      responseJson = this.get(nextUrl);
      results.push.apply(results, responseJson.results);
      nextUrl = responseJson.next;
    }
    return results;
  };
}

/**
 * Recursively unpack/flatten a (potentially) nested result from a Robinhood API endpoint list response.
 *
 * e.g. GET https://api.robinhood.com/positions/
 * "results": [
 *    {
 *       "shares_held_for_stock_grants": "0.0000",
 *       "account": "https://api.robinhood.com/accounts/<foo>/",
 *       "pending_average_buy_price": "0.0000",
 *       "shares_held_for_options_events": "0.0000",
 *       "intraday_average_buy_price": "0.0000",
 *       "url": "https://api.robinhood.com/positions/<foo>/e6a6e495-3db9-4129-8baf-50d4247b1d9c/",
 *       "shares_held_for_options_collateral": "0.0000",
 *       "created_at": "2016-05-13T05:47:26.756367Z",
 *       "updated_at": "2017-01-26T19:02:49.066776Z",
 *       "shares_held_for_buys": "0.0000",
 *       "average_buy_price": "89.4400",
 *       "instrument": "https://api.robinhood.com/instruments/e6a6e495-3db9-4129-8baf-50d4247b1d9c/",
 *       "intraday_quantity": "0.0000",
 *       "shares_held_for_sells": "0.0000",
 *       "shares_pending_from_options_events": "0.0000",
 *       "quantity": "0.0000"
 *    },
 *    ...
 * ]
 *
 * Additionally, this function recursively gets hyperlinked related entities (e.g. `instrument` in the
 * above example) and adds keys/values of the related result to the final flattened object until our
 * stop condition is met -- all hyperlinked related entities specified are already fetched.
 *
 * This function does not return but modifies the final flattened object passed to the function in place.
 */
function flattenResult_(result, flattenedResult, hyperlinkedFields, endpoint) {
  for (var key in result) {
    if (result.hasOwnProperty(key)) {
      var value = result[key];
      if (hyperlinkedFields.indexOf(key) >= 0) {
        if (key === 'option') {
          endpoint = 'marketData';
          var url = robinhoodApiBaseUrl + robinhoodApiUriMap[endpoint] + value;
          var responseJson = apiClient.get(url);
          flattenResult_(responseJson.results[0], flattenedResult, hyperlinkedFields, endpoint);
        }
        var responseJson = apiClient.get(value);
        hyperlinkedFields.splice(hyperlinkedFields.indexOf(key), 1);
        flattenResult_(responseJson, flattenedResult, hyperlinkedFields, key);
      } else if (value === Object(value) && !Array.isArray(value)) {
        flattenResult_(value, flattenedResult, hyperlinkedFields, endpoint);
      } else if (Array.isArray(value) && key !== 'executions') {
        // TODO: Handle field values that are arrays longer than one and "executions" fields.
        // It is hard to unpack these fields due to their unknown length. e.g. the `/options/orders/`
        // endpoint returns a "legs" field that likely contains multiple components and executions
        // if an options strategy contains multiple contracts.
        flattenResult_(value[0], flattenedResult, hyperlinkedFields, endpoint);
      } else {
        // Append our endpoint identifier to make duplicate keys unique
        modifiedKey = key + '_' + endpoint;
        flattenedResult[modifiedKey] = value;
      }
    }
  }
}

/**
 * Iterate through all results of a Robinhood API endpoint list response and build
 * a two-dimensional array. Apps Script will use this array of values to populate
 * cells in a tabular format.
 */
function getRobinhoodData_(endpoint, hyperlinkedFields) {
  var data = [];
  var url = robinhoodApiBaseUrl + robinhoodApiUriMap[endpoint];
  var results = apiClient.pagedGet(url);
  for (var i = 0;  i < results.length; i++) {
    var flattenedResult = {};
    var hyperlinkedFieldsCopy = hyperlinkedFields.slice();
    flattenResult_(results[i], flattenedResult, hyperlinkedFieldsCopy, endpoint);
    if (!data.length) {
      // Add header column names (object keys) only once
      var keys = Object.keys(flattenedResult);
      data.push(keys);
    }
    // Add all object values
    var values = Object.keys(flattenedResult).map(function(key) { return flattenedResult[key]; });
    data.push(values);
  }
  return data;
}

/**
 * Instantiate Robinhood API client
 */
var apiClient = new apiClient_();

/**
 * Get `ACH transfers` data.
 * @customfunction
 */
function ROBINHOOD_GET_ACH_TRANSFERS(datetime) {
  return getRobinhoodData_('achTransfers', ['ach_relationship']);
}

/**
 * Get `dividends` data.
 * @customfunction
 */
function ROBINHOOD_GET_DIVIDENDS(datetime) {
  return getRobinhoodData_('dividends', ['instrument']);
}

/**
 * Get `documents` data. Download URLs for trade confirmations, account statements, and 1099s.
 * @customfunction
 */
function ROBINHOOD_GET_DOCUMENTS(datetime) {
  return getRobinhoodData_('documents', []);
}

/**
 * Get `options orders` data.
 * @customfunction
 */
function ROBINHOOD_GET_OPTIONS_ORDERS(datetime) {
  return getRobinhoodData_('optionsOrders', ['option']);
}

/**
 * Get current and past `options positions` data.
 * @customfunction
 */
function ROBINHOOD_GET_OPTIONS_POSITIONS(datetime) {
  return getRobinhoodData_('optionsPositions', ['option']);
}

/**
 * Get `stock orders` data.
 * @customfunction
 */
function ROBINHOOD_GET_ORDERS(datetime) {
  return getRobinhoodData_('orders', ['instrument', 'position']);
}

/**
 * Get `portfolios` data. Only one portfolio is returned (for now?).
 * @customfunction
 */
function ROBINHOOD_GET_PORTFOLIOS(datetime) {
  return getRobinhoodData_('portfolios', []);
}

/**
 * Get current and past `stocks positions` data.
 * @customfunction
 */
function ROBINHOOD_GET_POSITIONS(datetime) {
  return getRobinhoodData_('positions', ['instrument', 'fundamentals', 'quote']);
}

/**
 * Get `watchlist` data.
 * @customfunction
 */
function ROBINHOOD_GET_WATCHLIST(datetime) {
  return getRobinhoodData_('watchlist', ['instrument', 'fundamentals', 'quote']);
}

function refreshLastUpdate_() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  spreadsheet.getSheetByName('Refresh').getRange('A1').setValue(new Date().toTimeString());
}

/**
 * TL;DR: Calling a `ROBINHOOD_GET` function _without_ changing the argument passed to function will _not_ return new data.
 * A `Refresh Data` custom menu item is created so that data can be refreshed.
 *
 * Apps Script custom functions are deterministic and will only recalculate if their arguments change. All `ROBINHOOD_GET`
 * functions have an optional `datetime` parameter so that the current datetime can be passed to the function in order to
 * force recalculation. A Google Sheets custom menu with a `Refresh Data` item is implemented so that a current datetime value
 * can be set in cell `Refresh!$A$1`. `ROBINHOOD_GET` functions that reference this cell will return non-cached, fresh results
 * when `Refresh Data` is clicked.
 * Stolen from https://stackoverflow.com/a/17347290.
 *
 * Example:
 * =ROBINHOOD_GET_POSITIONS(Refresh!$A$1)
 */
function onOpen() {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var refreshSheet = spreadsheet.getSheetByName('Refresh');
  if (refreshSheet === null) {
   refreshSheet = spreadsheet.insertSheet('Refresh');
  }
  spreadsheet.moveActiveSheet(1);
  var entries = [{ name: 'Refresh Data', functionName: 'refreshLastUpdate_' }];
  spreadsheet.addMenu('Refresh Data', entries);
}
