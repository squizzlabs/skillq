<?php

if (!function_exists('get_magic_quotes_gpc')) {
    function get_magic_quotes_gpc() {
        return false;
    }
}


$t = microtime(true);

// Fire up the session!
session_cache_limiter(false);
session_set_cookie_params(86400 * 7);
session_start();
setcookie(session_name(), session_id(), time() + (86400 * 7), '/', '.skillq.net', true, true);

// Autoload Slim + Twig
require( __DIR__ . "/vendor/autoload.php" );

// Load modules + database stuff (and the config)
require( "init.php" );

// initiate the timer!
$timer = new Timer();

// Start slim and load the config from the config file
$app = new \Slim\Slim($config);

// Error handling
$app->error(function (\Exception $e) use ($app){
    include ( "view/error.php" );
});

// Check if the user has autologin turned on
//if(!User::isLoggedIn()) User::autoLogin();

// Load the routes - always keep at the bottom of the require list ;)
include( "routes.php" );

// Load twig stuff
include( "twig.php" );

// Run the thing!
$app->run();
