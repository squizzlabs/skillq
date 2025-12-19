<?php

require_once "../init.php";

$minute = date("Hi");
while ($minute == date("Hi") && $redis->get("skq:tqStatus") == "ONLINE") {
    $items = Db::query("select typeID from skq_items where lastUpdate < date_sub(now(), interval 7 day) order by lastUpdate limit 10");
    foreach ($items as $item) {
        $typeID = $item['typeID'];
        $url = "https://esi.evetech.net/universe/types/$typeID";
        $raw = file_get_contents($url);
        $json = json_decode($raw, true);
        Db::execute("update skq_items set typeName = :name, lastUpdate = now() where typeID = :typeID", ['name' => $json['name'], 'typeID' => $typeID]);
        sleep(1);
    }

	sleep(1);
}
