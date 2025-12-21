<?php

/**
 * Class Info
 */
class Info
{
    /**
     * Retrieve the system id of a solar system.
     *
     * @static
     * @param    $systemName
     * @return int The solarSystemID
     */
    public static function getSystemID($systemName)
    {
        return Db::queryField(
          "select solarSystemID from ccp_systems where solarSystemName = :name",
          "solarSystemID",
          array(":name" => $systemName),
         3600
        );
    }

    /**
     * @static
     * @param    $systemID
     * @return array Returns an array containing the solarSystemName and security of a solarSystemID
     */
    public static function getSystemInfo($systemID)
    {
        return Db::queryRow(
          "select solarSystemName, security, sunTypeID from ccp_systems where solarSystemID = :systemID",
          array(":systemID" => $systemID),
         3600
        );
    }

    /**
     * @param $systemID
     * @return array
     */
    public static function getWormholeSystemInfo($systemID)
    {
        return Db::queryRow(
          "select * from ccp_zwormhole_info where solarSystemID = :systemID",
          array(":systemID" => $systemID),
         3600
        );
    }

    /**
     * @static
     * @param    $systemID
     * @return string The system name of a solarSystemID
     */
    public static function getSystemName($systemID)
    {
        $systemInfo = Info::getSystemInfo($systemID);

        return $systemInfo['solarSystemName'];
    }

    /**
     * @static
     * @param    int $systemID
     * @return double The system secruity of a solarSystemID
     */
    public static function getSystemSecurity($systemID)
    {
        $systemInfo = Info::getSystemInfo($systemID);

        return $systemInfo['security'];
    }

    /**
     * @static
     * @param    $typeID
     * @return string The item name.
     */
    public static function getItemName($typeID)
    {
        global $redis;
        $name = $redis->get("name:$typeID");
        if ($name != "") return $name;

        $name = Db::queryField("select typeName from skq_items where typeID = :typeID", "typeName", ['typeID' => $typeID]);
        if ($name != "") {
            $redis->setex("name:$typeID", 3600, $name);
            return $name;
        }
        Db::execute("insert ignore into skq_items (typeID) values(:typeID)", ['typeID' => $typeID]);

        $name = Db::queryField(
          "select typeName from ccp_invTypes where typeID = :typeID",
          "typeName",
          array(":typeID" => $typeID),
         3600
        );

        if ($name === null) {
            return "TypeID $typeID";
        }

        return $name;
    }

    /**
     * @param    $itemName
     * @return int The typeID of an item.
     */
    public static function getItemID($itemName)
    {
        global $redis;
        $typeID = $redis->get("itemName:$itemName");
        if ($typeID != "") return (int) $typeID;

        $typeID = Db::queryField(
          "select typeID from ccp_invTypes where upper(typeName) = :typeName",
          "typeID",
          array(":typeName" => strtoupper($itemName)),
         3600
        );

        $redis->setex("itemName:$itemName", 3600, $typeID);
        return $typeID;
    }

    /**
     * Retrieves the effectID of an item.    This is useful for determining if an item is fitted into a low,
     * medium, high, rig, or t3 slot.
     *
     * @param    $typeID
     * @return int The effectID of an item.
     */
    public static function getEffectID($typeID)
    {
        return Db::queryField(
          "select effectID from ccp_dgmTypeEffects where typeID = :typeID and effectID in (11, 12, 13, 2663, 3772)",
          "effectID",
          array(":typeID" => $typeID),
         3600
        );
    }

    /**
     * @param $name
     * @return int|null|string
     */
    public static function getCorpId($name)
    {
        return Db::queryField(
          "select corporationID from skq_corporations where name = :name order by memberCount desc limit 1",
          "corporationID",
          array(":name" => $name),
         3600
        );
    }

    /**
     * @param $id
     * @return int|null|string
     */
    public static function getAlliName($id)
    {
        global $redis;
        $name = $redis->get("alli:$id");
        if ($name != "") return $name;

        $name = Db::queryField(
          "select allianceName from skq_alliances where allianceID = :id limit 1",
          "allianceName",
          array(":id" => $id),
         3600
        );

        $redis->setex("alli:$id", 3600, $name);
        return $name;
    }

    /**
     * @param $name
     * @return int|null|string
     */
    public static function getFactionId($name)
    {
        return Db::queryField(
          "select factionID from skq_factions where name = :name",
          "factionID",
          array(":name" => $name),
         3600
        );
    }

    /**
     * @param $id
     * @return int|null|string
     */
    public static function getFactionName($id)
    {
        return Db::queryField("select name from skq_factions where factionID = :id", "name", array(":id" => $id),3600);
    }

    /**
     * @param $id
     * @return int|null|string
     */
    public static function getRegionName($id)
    {
        $data = Db::queryField(
          "select regionName from ccp_regions where regionID = :id",
          "regionName",
          array(":id" => $id),
         3600
        );

        return $data;
    }

    /**
     * @param $name
     * @return int|null|string
     */
    public static function getRegionID($name)
    {
        return Db::queryField(
          "select regionID from ccp_regions where regionName = :name",
          "regionID",
          array(":name" => $name),
         3600
        );
    }

    /**
     * @param $systemID
     * @return int|null|string
     */
    public static function getRegionIDFromSystemID($systemID)
    {
        $regionID = Db::queryField(
          "select regionID from ccp_systems where solarSystemID = :systemID",
          "regionID",
          array(":systemID" => $systemID),
         3600
        );

        return $regionID;
    }

    /**
     * @param $name
     * @return int|null|string
     */
    public static function getShipId($name)
    {
        $shipID = Db::queryField(
          "select typeID from ccp_invTypes where typeName = :name",
          "typeID",
          array(":name" => $name),
         3600
        );

        return $shipID;
    }

    /**
     * Attempt to find the name of a corporation in the corporations table.
     *
     * @static
     * @param int $id
     * @return string The name of the corp if found, null otherwise.
     */
    public static function getCorpName($id)
    {
        global $redis;
        $name = $redis->get("corp:$id");
        if ($name != "") return $name;

        $name = Db::queryField(
          "select corporationName from skq_corporations where corporationID = :id",
          "corporationName",
          array(":id" => $id),
         3600
        );
        if ($name != null) {
            $redis->setex("corp:$id", 3600, $name);
            return $name;
        }

        return "Corporation $id";
    }

    /**
     * @param $name
     * @return int|null|string
     */
    public static function getAlliId($name)
    {
        return Db::queryField(
          "select allianceID from skq_alliances where name = :name",
          "allianceID",
          array(":name" => $name),
         3600
        );
    }

    /**
     * @param $name
     * @return int|null|string
     */
    public static function getCharId($name)
    {
        return Db::queryField(
          "select characterID from skq_characters where name = :name",
          "characterID",
          array(":name" => $name),
         3600
        );
    }

    /**
     * Attempt to find the name of a character in the characters table.
     *
     * @static
     * @param int $id
     * @return string The name of the corp if found, null otherwise.
     */
    public static function getCharName($id)
    {
        global $redis;
        $name = $redis->get("charName:$id");
        if ($name != "") return $name;

        $name = Db::queryField(
          "select characterName from skq_character_info where characterID = :id",
          "characterName",
          array(":id" => $id),
         3600
        );
        if ($name == "" || $name == null) $name = "Character $id";
        $redis->setex("charName:$id", 30, $name);
        return $name;
    }

    /**
     * @param $id
     * @return int|null|string
     */
    public static function getGroupID($id)
    {
        global $redis;
        $groupID = $redis->get("typeID2groupID:$id");
        if ($groupID != "") return (int) $groupID;

        $groupID = (int) Db::queryField(
          "select groupID from ccp_invTypes where typeID = :id",
          "groupID",
          array(":id" => $id),
         3600
        );

        $redis->setex("typeID2groupID:$id", 3600, $groupID);
        return $groupID;
    }

    /**
     * @param $id
     * @return int|null|string
     */
    public static function getGroupIdFromName($id)
    {
        global $redis;
        
        $groupID = $redis->get("groupID:$id");
        if ($groupID != "") return (int) $groupID;

        $groupID = Db::queryField(
          "select groupID from ccp_invGroups where groupName = :id",
          "groupID",
          array(":id" => $id),
         3600
        );
        if ($groupID === null) {
            return 0;
        }

        $redis->setex("groupID:$id", 3600, $id);
        return $groupID;
    }

    /**
     * Get the name of the group
     *
     * @static
     * @param int $groupID
     * @return string
     */
    public static function getGroupName($groupID)
    {
        global $redis;

        $name = $redis->get("group:$groupID");
        if ($name != "") return $name;

        $name = Db::queryField(
          "select groupName from ccp_invGroups where groupID = :id",
          "groupName",
          array(":id" => $groupID),
         3600
        );

        $redis->setex("group:$groupID", 3600, $name);
        return $name;
    }

    /**
     * @param $resultArray
     * @param $type
     * @param $query
     * @param $search
     */
    private static function findEntitySearch(&$resultArray, $type, $query, $search)
    {
        $results = Db::query("${query}", array(":search" => $search), 30);
        Info::addResults($resultArray, $type, $results);
    }

    /**
     * @param $resultArray
     * @param $type
     * @param $results
     */
    private static function addResults(&$resultArray, $type, $results)
    {
        foreach ($results as $result) {
            $keys                        = array_keys($result);
            $result["type"]              = $type;
            $value                       = $result[$keys[0]];
            $resultArray["$type|$value"] = $result;
        }
    }

    private static $entities = array(
      array("faction", "SELECT factionID FROM skq_factions WHERE name "),
      array("alliance", "SELECT allianceID FROM skq_alliances WHERE name "),
      array("alliance", "SELECT allianceID FROM skq_alliances WHERE ticker "),
      array("corporation", "SELECT corporationID FROM skq_corporations WHERE name "),
      array("corporation", "SELECT corporationID FROM skq_corporations WHERE ticker "),
      array("character", "SELECT characterID FROM skq_characters WHERE name "),
      array("item", "select typeID from ccp_invTypes where published = 1 and typeName "),
      array("system", "select solarSystemID from ccp_systems where solarSystemName "),
      array("region", "select regionID from ccp_regions where regionName "),
    );

    /**
     * @param $id
     * @return mixed
     */
    public static function getCorpDetails($id)
    {

        $data = Db::queryRow(
          "select corporationID, allianceID, 0 factionID from skq_corporations where corporationID = :id",
          array(":id" => $id),
         3600
        );
        if ($data == null || sizeof($data) == 0) {
            $data["corporationID"] == $id;
        }
        $moreData = Db::queryRow("select * from skq_corporations where corporationID = :id", array(":id" => $id),3600);
        if ($moreData) {
            $data["memberCount"] = $moreData["memberCount"];
            $data["cticker"]     = $moreData["ticker"];
            $data["ceoID"]       = $moreData["ceoID"];
        }
        Info::addInfo($data);

        return Summary::getCorpSummary($data, $id);
    }

    /**
     * @param $id
     * @return mixed
     */
    public static function getAlliDetails($id)
    {
        $data = array();
        $data["allianceID"] == $id;
        // Add membercount, etc.
        $moreData = Db::queryRow("select * from skq_alliances where allianceID = :id", array(":id" => $id),3600);
        if ($moreData) {
            $data["memberCount"]    = $moreData["memberCount"];
            $data["aticker"]        = $moreData["ticker"];
            $data["executorCorpID"] = $moreData["executorCorpID"];
        }
        Info::addInfo($data);

        return Summary::getAlliSummary($data, $id);
    }

    /**
     * @param $id
     * @return mixed
     */
    public static function getFactionDetails($id)
    {
        $data              = array();
        $data["factionID"] = $id;
        Info::addInfo($data);

        return Summary::getFactionSummary($data, $id);
    }

    /**
     * @param $id
     * @return mixed
     */
    public static function getSystemDetails($id)
    {
        $data = array("solarSystemID" => $id);
        Info::addInfo($data);

        return Summary::getSystemSummary($data, $id);
    }

    /**
     * @param $id
     * @return mixed
     */
    public static function getRegionDetails($id)
    {
        $data = array("regionID" => $id);
        Info::addInfo($data);

        return Summary::getRegionSummary($data, $id);
    }

    /**
     * @param $id
     * @return mixed
     */
    public static function getGroupDetails($id)
    {
        $data = array("groupID" => $id);
        Info::addInfo($data);

        return Summary::getGroupSummary($data, $id);
    }

    /**
     * @param $id
     * @return mixed
     */
    public static function getShipDetails($id)
    {
        $data = array("shipTypeID" => $id);
        Info::addInfo($data);
        $data["shipTypeName"] = $data["shipName"];

        return Summary::getShipSummary($data, $id);
    }


    /**
     * @param $id
     * @return array
     */
    public static function getSystemsInRegion($id)
    {
        $result = Db::query("select solarSystemID from ccp_systems where regionID = :id", array(":id" => $id),3600);
        $data   = array();
        foreach ($result as $row) {
            $data[] = $row["solarSystemID"];
        }

        return $data;
    }

    /**
     * @param $id
     * @return int|null|string
     */
    public static function getRefTypeName($id)
    {
        global $redis;
        $name = $redis->get("refName:$id");
        if ($name != "") return $name;

        $name = Db::queryField(
          "select refTypeName from ccp_api_refTypes where refTypeID = :id",
          "refTypeName",
          array(":id" => $id)
        );
        $redis->setex("refName:$id", 3600, $name);
        return $name;
    }

    /**
     * @param mixed $element
     * @return mixed
     */
    public static function addInfo(&$element)
    {
        if ($element != null) {
            foreach ($element as $key => $value) {
                if (is_array($value)) {
                    $element[$key] = Info::addInfo($value);
                } else {
                    if ($value != 0) {
                        switch ($key) {
                            case "trainingEndTime":
                                $unixTime                   = strtotime($value);
                                $diff                       = $unixTime - time();
                                $element["trainingSeconds"] = $diff;
				$element["deltaTime"] = $diff;
                                break;
                            case "lastChecked":
                                //$element["lastCheckedTime"] = date("Y-m-d H:i", $value);
                                break;
                            case "cachedUntil":
                            case "queueFinishes":
                            case "endTime":
                                $unixTime                 = strtotime($value);
                                $diff                     = $unixTime - time();
                                $element["${key}Seconds"] = $diff;
				if (isset($element['startTime'])) $element["deltaTime"] = $unixTime - strtotime($element['startTime']);
                                break;
                            case "unix_timestamp":
                                $element["ISO8601"]      = date("c", $value);
                                $element["killTime"]     = date("Y-m-d H:i", $value);
                                $element["MonthDayYear"] = date("F j, Y", $value);
                                break;
                            case "shipTypeID":
                                if (!isset($element["shipName"])) {
                                    $element["shipName"] = Info::getItemName($value);
                                }
                                if (!isset($element["groupID"])) {
                                    $element["groupID"] = Info::getGroupID($value);
                                }
                                if (!isset($element["groupName"])) {
                                    $element["groupName"] = Info::getGroupName($element["groupID"]);
                                }
                                break;
                            case "groupID":
                                global $loadGroupShips; // ugh
                                if (!isset($element["groupName"])) {
                                    $element["groupName"] = Info::getGroupName($value);
                                }
                                if ($loadGroupShips && !isset($element["groupShips"]) && !isset($element["noRecursion"])) {
                                    /*$element["groupShips"] = Db::query(
                                      "select typeID as shipTypeID, typeName as shipName, raceID, 1 as noRecursion from ccp_invTypes where groupID = :id and published = 1 and marketGroupID is not null order by raceID, marketGroupID, typeName",
                                      array(":id" => $value),
                                     3600
                                    );*/
                                }
                                break;
                            case "executorCorpID":
                                //$element["executorCorpName"] = Info::getCorpName($value);
                                break;
                            case "ceoID":
                                $element["ceoName"] = Info::getCharName($value);
                                break;
                            case "characterID":
                                $element["characterName"] = Info::getCharName($value);
				$scopeCount = Db::queryField("select count(*) count from skq_scopes where characterID = :charID", "count", [':charID' => $value], 3);
				$element['missingScopes'] = ($scopeCount < 4);
                                break;
                            case "corporationID":
                                $element["corporationName"] = Info::getCorpName($value);
                                break;
                            case "allianceID":
                                $element["allianceName"] = Info::getAlliName($value);
                                break;
                            case "factionID":
                                $element["factionName"] = Info::getFactionName($value);
                                break;
                            case "weaponTypeID":
                                $element["weaponTypeName"] = Info::getItemName($value);
                                break;
                            case "refTypeID":
                                $element["refTypeName"] = Info::getRefTypeName($value);
                                break;
                            case "typeID":
                                if (!isset($element["typeName"])) {
                                    $element["typeName"] = Info::getItemName($value);
                                }
                                $groupID = Info::getGroupID($value);
                                if (!isset($element["groupID"])) {
                                    $element["groupID"] = $groupID;
                                }
                                if (!isset($element["groupName"])) {
                                    $element["groupName"] = Info::getGroupName($groupID);
                                }
                                //if (!isset($element["fittable"])) $element["fittable"] = Info::getEffectID($value) != null;
                                break;
                            case "level":
			    case "requiredSkillLevel":
                            case "trainingToLevel":
                                $tLevels           = array("I", "II", "III", "IV", "V");
                                $element["tLevel"] = $tLevels[$value - 1];
                                break;
			    case "neededLevel":
                                $tLevels           = array("I", "II", "III", "IV", "V");
                                $element["neededLevel"] = $tLevels[$value - 1];
                                break;
                            case "subFlag":
                                if ($value == 0) {
                                    $element["subStatus"] = "";
                                }
                                if ($value == 1) {
                                    $element["subStatus"] = "Subscription Expiring...";
                                }
                                if ($value == 2) {
                                    $element["subStatus"] = "Subscription Expired!";
                                }
                                break;
			    case "endSP":
				$element['deltaSP'] = $element['endSP'] - $element['startSP'];
				break;
                        }
                    }
                }
            }
        }

	if (isset($element['deltaSP']) && isset($element['deltaTime']) && $element['deltaTime'] > 0) {
		$element['spHour'] = round($element['deltaSP'] / ($element['deltaTime'] / 3600));
	}

        return $element;
    }
}
