<?php
require_once __DIR__ . "/config.php";
require_once __DIR__ . "/vendor/autoload.php";

spl_autoload_register("zkbautoload");

function zkbautoload($class_name)
{
	$baseDir = dirname(__FILE__);
	$fileName = "$baseDir/classes/$class_name.php";
	if (file_exists($fileName))
	{
		require_once $fileName;
		return;
	}
}

$redis = new Redis();
$redis->pconnect($redisServer, $redisPort, 3600);
$redis->clearLastError();
