<?php

require_once "../init.php";

use zkillboard\eveonlineoauth2\EveOnlineSSO;

global $clientID, $secretKey, $callbackURL, $scopes;
$sso = new EveOnlineSSO($clientID, $secretKey, $callbackURL, $scopes);

Db::execute("delete from skq_corporations where corporationID = 0");
Db::execute("delete from skq_alliances where allianceID = 0");

$count = 0;
$minute = date("Hi");
while ($minute == date("Hi") && $redis->get("skq:tqStatus") == "ONLINE") {
	$corps = Db::query("select * from skq_corporations where lastUpdate < date_sub(now(), interval 7 day) order by lastUpdate limit 10");
	foreach ($corps as $corp) {
        if ($minute !== date('Hi')) break;
		$corpID = $corp['corporationID'];
        if ($corpID == 0) continue;
		$url = "https://esi.evetech.net/corporations/$corpID/";
		$raw = file_get_contents($url);
		$json = json_decode($raw, true);
		if (isset($json['name'])) {
			$name = $json['name'];
			Db::execute("update skq_corporations set corporationName = :name, lastUpdate = now() where corporationID = :id", [':id' => $corpID, ':name' => $name]);
			$count++;
		}
        sleep(1);
	}
    Db::execute("delete from skq_alliances where allianceID = 0");
	$allis = Db::query("select * from skq_alliances where lastUpdate < date_sub(now(), interval 7 day) order by lastUpdate limit 10");
	foreach ($allis as $alli) {
        if ($minute !== date('Hi')) break;
		$alliID = $alli['allianceID'];
        if ($alliID == 0) continue;
		$url = "https://esi.evetech.net/alliances/$alliID/";
		$raw = file_get_contents($url);
		$json = json_decode($raw, true);
		if (isset($json['name'])) {
			$name = $json['name'];
			Db::execute("update skq_alliances set allianceName = :name, lastUpdate = now() where allianceID = :id", [':id' => $alliID, ':name' => $name]);
			$count++;
		}
        sleep(1);
	}
	sleep(1);
}
if ($count > 0) Util::out("Entities Processed $count => " . number_format($count / 60, 1) . "rps");

