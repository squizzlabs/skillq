<?php

require_once "../init.php";

use zkillboard\eveonlineoauth2\EveOnlineSSO;

$guzzler = Util::getGuzzler(10);

global $clientID, $secretKey, $callbackURL, $scopes;

$accessTokens = [];
$errorTokens = [];

$sso = new EveOnlineSSO($clientID, $secretKey, $callbackURL, $scopes);

$count = 0;
$i = [];
Db::execute("update skq_scopes set lastSsoChecked = 0 where errorCount > 0 and lastErrorCode in (403, 502)");
$minutely = date('Hi');
while ($minutely == date('Hi') && $redis->get("skq:tqStatus") == "ONLINE") {
    $guzzler->finish();
    while ($redis->llen("skq:esiQueue")) sleep(1);

    while ($minutely == date('Hi') && $redis->llen("skq:esiQueue") > 0) usleep(5000);

    $chars = [];
	$rows = Db::query("select characterID, scope, refresh_token from skq_scopes where lastSsoChecked < date_sub(now(), interval 60 minute) and errorCount < 10 and refresh_token != '' order by lastSsoChecked", [], 0);
    if (sizeof($rows) == 0) sleep(1);
    $timerGlobal = new Timer();
	foreach ($rows as $row) {
        if ($minutely != date('Hi')) break;
		$charID = $row['characterID'];
        if ($charID == null) continue;

        // ensure the character's owner has accessed skillq recently
        $recent = Db::queryField("select count(*) count from skq_users where characterID = :charID and lastAccess >= date_sub(now(), interval 1 week)" , "count", ['charID' => $charID]);
        if ($recent == 0) {
            // check association
            $assocCharID = Db::queryField("select char1 from skq_character_associations where char2 = :charID", "char1", ['charID' => $charID]);
            $recent = Db::queryField("select count(*) count from skq_users where characterID = :charID and lastAccess >= date_sub(now(), interval 1 week)", "count", ['charID' => $assocCharID]);
        }

        if (array_search($charID, $chars) !== false) continue;
        $chars[] = $charID;

        $timerChar = new Timer();
		if (in_array($charID, $i)) continue;
		$i[] = $charID;
		Db::execute("update skq_scopes set lastSsoChecked = now() where characterID = :charID", [':charID' => $charID]);
        if ($recent == 0) {
            Util::out("Skipping $charID");
            continue;
        }
        Util::out("Prepping $charID");
		$refreshToken = $row['refresh_token'];

        try {
            $accessToken = $sso->getAccessToken($refreshToken);
        } catch (Exception $ex) {
            DB::execute("delete from skq_scopes where characterID = :charID", [":charID" => $charID]);
            continue;
        }
	    $scopes = Db::query("select * from skq_scopes where characterID = :charID", [':charID' => $charID]);
        $count++;
        foreach ($scopes as $r) {
		    $r['accessToken'] = $accessToken;
            Db::execute("update skq_scopes set errorCount = 0, lastErrorCode = 0 where characterID = :charID and scope = :scope", [':charID' => $r['characterID'], ':scope' => $r['scope']]);
            $redis->rpush("skq:esiQueue", serialize($r));
        }
        for ($j = 0; $j < 5; $j++) { usleep(250000); $guzzler->tick(); }
	}
}
$guzzler->finish();
if ($count > 0) Util::out("SSO Processed $count => " . number_format($count / 60, 1) . "rps");


function accessTokenSuccess(&$guzzler, &$params, &$content)
{
	global $redis;
    echo "success\n";

	$row = $params['row'];
	$charID = $row['characterID'];
	$refreshToken = $row['refresh_token'];

	$json = json_decode($content, true);
	$accessToken = @$json['access_token'];

	$scopes = Db::query("select * from skq_scopes where characterID = :charID", [':charID' => $charID]);
	foreach ($scopes as $row) {
		$row['accessToken'] = $accessToken;	
		Db::execute("update skq_scopes set errorCount = 0, lastErrorCode = 0 where characterID = :charID and scope = :scope", [':charID' => $row['characterID'], ':scope' => $row['scope']]);
		$redis->rpush("skq:esiQueue", serialize($row));
	}
}

function fail($guzzler, $params, $ex)
{
	$code = $ex->getCode();
	$row = $params['row'];

	switch ($code) {
		case 0:
		case 502:
		case 504:
			Db::execute("update skq_scopes set lastSsoChecked = 0 where characterID = :charID and scope = :scope", [':charID' => $row['characterID'], ':scope' => $row['scope'], ':code' => $code]);
			break;
		case 400:
			if (strpos($ex->getMessage(), "invalid_token") !== false) {
				// Delete twice as quick
				Db::execute("update skq_scopes set errorCount = errorCount + 1, lastErrorCode = :code where characterID = :charID and scope = :scope", [':charID' => $row['characterID'], ':scope' => $row['scope'], ':code' => $code]);
			}
			break;
		default:
			Util::out("refresh token: " .$code . " " . $ex->getMessage(). "\n" . print_r($row, true));
	}

	Db::execute("update skq_scopes set errorCount = errorCount + 1, lastErrorCode = :code where characterID = :charID and scope = :scope", [':charID' => $row['characterID'], ':scope' => $row['scope'], ':code' => $code]);
}
