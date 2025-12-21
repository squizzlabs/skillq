<?php

require_once "../init.php";

use zkillboard\crestsso\CrestSSO;

$guzzler = Util::getGuzzler(4);

global $clientID, $secretKey, $callbackURL, $scopes;

$errorTokens = [];

$count = 0;
$minutely = date('Hi');
while ($minutely == date('Hi') && $redis->get("skq:tqStatus") == "ONLINE") {
	$row = unserialize($redis->lpop("skq:esiQueue"));
	if ($row == null) {
        for ($tt = 0; $tt <= 100; $tt++) { $guzzler->tick(); usleep(10000); }
		continue;
	}

	$charID = $row['characterID'];
	$scope = $row['scope'];
	$refreshToken = $row['refresh_token'];
	$accessToken = @$row['accessToken'];
    //Util::out("$charID $scope");

	$headers = ['Authorization' =>"Bearer $accessToken", "Content-Type" => "application/json"];
	$params = ['row' => $row];

	$count++;
	switch ($scope) {
		case 'esi-skills.read_skills.v1':
            $headers['X-Compatibility-Date'] = '2099-01-01';
			$url = "https://esi.evetech.net/characters/$charID/skills";
			$guzzler->call($url, "loadSkills", "fail", $params, $headers);
			break;
		case 'esi-skills.read_skillqueue.v1':
            $headers['X-Compatibility-Date'] = '2099-01-01';
			$url = "https://esi.evetech.net/characters/$charID/skillqueue";
			$guzzler->call($url, "loadQueue", "fail", $params, $headers);
			break;
		case 'esi-wallet.read_character_wallet':
			$url = "https://esi.evetech.net/characters/$charID/wallet/";
			$guzzler->call($url, "loadWallet", "fail", $params, $headers);
			break;
		case 'publicData':
			$url = "https://esi.evetech.net/characters/$charID/";
			$guzzler->call($url, "loadPublicData", "fail", $params, $headers);
			break;
		default:
			Util::out("Unknown scope: $scope");
	}
    $guzzler->tick();
}
$guzzler->finish();
if ($count > 0) Util::out("Fetch Processed $count => " . number_format($count / 60, 1) . "rps");

function loadSkills(&$guzzler, &$params, &$content, $headers)
{
	if ($content != "") {
		$skills = json_decode($content, true);
		$charID = $params['row']['characterID'];
		if (isset($skills['skills'])) {
			foreach ($skills['skills'] as $skill) {
				Db::execute("insert ignore into skq_character_skills (characterID, typeID) values (:charID, :typeID)", [':charID' => $charID, ':typeID' => $skill['skill_id']]);
				Db::execute("update skq_character_skills set level = :level, skillPoints = :points where characterID = :charID and typeID = :typeID", [':charID' => $charID, ':typeID' => $skill['skill_id'], ':level' => $skill['trained_skill_level'], ':points' => $skill['skillpoints_in_skill']]);
			}
			Db::execute("update skq_character_info set skillsTrained = :count, skillPoints = :sp where characterID = :charID", [':charID' => $charID, ':count' => count($skills['skills']), ':sp'=> $skills['total_sp']]);
		}
		Db::execute("update skq_character_info set unallocated_sp = :usp where characterID = :charID", [':charID' => $charID, ':usp' => ((int) @$skills['unallocated_sp'])]);
		//Util::out("Fetch: " . substr("$charID", strlen("$charID") - 6, 6)  . " esi-skills.read_skills.v1");
	}
	clearError($params['row']);
}

function loadQueue(&$guzzler, &$params, &$content, $headers) 
{
	$charID = $params['row']['characterID'];
	if ($content != "") {
		$queue = json_decode($content, true);
		Db::execute("delete from skq_character_queue where characterID = :charID", [":charID" => $charID]);
		Db::execute("update skq_character_skills set queue = 0 where characterID = :charID", [":charID" => $charID]);
		Db::execute("delete from skq_character_training where characterID = :charID", [':charID' => $charID]);
		if (sizeof($queue) > 0) {
            $sliced = array_slice($queue, 0, 1);
			$firstV = array_shift($sliced);
			if (isset($firstV['level_start_sp'])) {
				foreach ($queue as $qs) {
					Db::execute("insert ignore into skq_character_queue (characterID, queuePosition, typeID, level, startSP, endSP, startTime, endTime) values
							(:charID, :qp, :typeID, :level, :startSP, :endSP, :startTime, :endTime)",
							array(
								":charID"    => $charID,
								":qp"        => $qs['queue_position'],
								":typeID"    => $qs['skill_id'],
								":level"     => $qs['finished_level'],
								":startSP"   => $qs['training_start_sp'],
								":endSP"     => $qs['level_end_sp'],
								":startTime" => @$qs['start_date'],
								":endTime"   => @$qs['finish_date']
							     )
						   );
					Db::execute("update skq_character_skills set queue = :level where characterID = :charID and typeID = :typeID and :endTime > now() and queue = 0",
							[":charID" => $charID, ":typeID" => $qs['skill_id'], ":level" => $qs['finished_level'], ':endTime' => @$qs['finish_date']]);
				}
			}
		} 
		$maxQueueTime = Db::queryField("select max(endTime) endTime from skq_character_queue where characterID = :charID", "endTime", [':charID' => $charID]);
		Db::execute("update skq_character_info set queueFinishes = :endTime where characterID = :charID", [":charID" => $charID, ":endTime" => $maxQueueTime]);
	}
	//Util::out("Fetch: " . substr("$charID", strlen("$charID") - 6, 6) . " esi-skills.read_skillqueue.v1");
	clearError($params['row']);
}

function loadWallet(&$guzzler, &$params, &$content)
{
	if ($content != "") {
		$wallet = json_decode($content, true);
		$charID = $params['row']['characterID'];
		Db::execute("update skq_character_info set balance = :balance where characterID = :charID", [':charID' => $charID, ':balance' => $wallet]);
		//Util::out("Fetch: " . substr("$charID", strlen("$charID") - 6, 6) . " esi-wallet.read_character_wallet");
	}
	clearError($params['row']);
}

function loadPublicData(&$guzzler, &$params, &$content)
{
	if ($content != "") {
		$result = json_decode($content, true);
		$charID = $params['row']['characterID'];
		if (isset($result['name'])) {
			Db::execute("update skq_character_info set lastChecked = now(), characterName = :name, corporationID = :corp, allianceID = :alli where characterID = :charID", [":charID" => $charID, ":name" => $result['name'], ":corp" => (int) @$result['corporation_id'], ':alli' => (int) @$result['alliance_id']]);
			Db::execute("insert ignore into skq_corporations values (:corpID, :corpName, 0)", [':corpID' => (int) @$result['corporation_id'], ":corpName" => "Pending API Fetch"]);
			Db::execute("insert ignore into skq_alliances values (:alliID, :alliName, 0)", [':alliID' => (int) @$result['alliance_id'], ':alliName' => "Pending API Fetch"]);
		}
		//Util::out("Fetch: " . substr("$charID", strlen("$charID") - 6, 6) . " publicData");
	}
	clearError($params['row']);
}

function clearError($row)
{
	Db::execute("update skq_scopes set errorCount = 0, lastErrorCode = 0, lastChecked = now(), lastSsoChecked = now() where characterID = :charID and scope = :scope", [':charID' => $row['characterID'], ':scope' => $row['scope']]);
}

function fail($guzzler, $params, $ex)
{
	global $redis;

	$code = $ex->getCode();
	$row = $params['row'];

	Db::execute("update skq_scopes set lastErrorCode = :code, lastSsoChecked = now() where characterID = :charID and scope = :scope", [':charID' => $row['characterID'], ':scope' => $row['scope'], ':code' => $code]);

	$json = json_decode($params['content'], true);
	if (@$json['error'] == 'invalid_grant' || @$json['error'] == 'invalid_token') {
		$code = 400;
	}

	$row['attempts'] = 1 + @$row['attempts'];

	switch ($code) {
		default:
            $guzzler->tick();
            Util::out("Unknown error code $code");
            break;
        case 401:
            $guzzler->tick();
            break;
		case 420:
		case 0:
		case 400:
		case 403:
		case 500:
		case 502:
		case 504:
			sleep(1);
			if ($row['attempts'] < 3) $redis->lpush("skq:esiQueue", serialize($params['row']));
			if ($code == 420) {
				Util::out("420'ed");
				$guzzler->finish();
				exit();
			}
			break;
	}
}
