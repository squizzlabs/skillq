<?php

/**
 * Class Util
 */
class Util
{
    /**
     * @param string $string
     * @return string
     */
    public static function pluralize($string)
    {
        if (!Util::endsWith($string, "s")) {
            return $string . "s";
        } else {
            return $string . "es";
        }
    }

    /**
     * @param string $haystack
     * @param string $needle
     * @return bool
     */
    public static function startsWith($haystack, $needle)
    {
        $length = strlen($needle);

        return (substr($haystack, 0, $length) === $needle);
    }

    /**
     * @param string $haystack
     * @param string $needle
     * @return bool
     */
    public static function endsWith($haystack, $needle)
    {
        return substr($haystack, -strlen($needle)) === $needle;
    }

    /**
     * @param string $str
     * @return string
     */
    public static function firstUpper($str)
    {
        if (strlen($str) == 1) {
            return strtoupper($str);
        }
        $str = strtolower($str);

        return strtoupper(substr($str, 0, 1)) . substr($str, 1);
    }

    private static $formatIskIndexes = array("", "k", "m", "b", "t", "tt", "ttt");

    /**
     * @param double $value
     * @return string
     */
    public static function formatIsk($value)
    {
        $numDecimals = (((int) $value) == $value) && $value < 10000 ? 0 : 2;
        if ($value == 0) {
            return number_format(0, $numDecimals);
        }
        if ($value < 10000) {
            return number_format($value, $numDecimals);
        }
        $iskIndex = 0;
        while ($value > 999.99) {
            $value /= 1000;
            $iskIndex++;
        }

        return number_format($value, $numDecimals) . self::$formatIskIndexes[$iskIndex];
    }

    /**
     * @param string $string
     * @param int    $maxLength
     * @return string
     */
    public static function shortString($string, $maxLength)
    {
        if (strlen($string) <= $maxLength) {
            return $string;
        }

        return substr($string, 0, $maxLength - 3) . "...";
    }

    /**
     * @return double
     */
    public static function pageTimer()
    {
        global $timer;

        return $timer->stop();
    }

    /**
     * @param string $pageType
     * @param string $currentPage
     * @param string $retValue
     * @return string
     */
    public static function isActive($pageType, $currentPage, $retValue = "active")
    {
        return strtolower($pageType) == strtolower($currentPage) ? $retValue : "";
    }

    private static $months = array(
      "",
      "JAN",
      "FEB",
      "MAR",
      "APR",
      "MAY",
      "JUN",
      "JUL",
      "AUG",
      "SEP",
      "OCT",
      "NOV",
      "DEC"
    );

    /**
     * @param int $month
     * @return string
     */
    public static function getMonth($month)
    {
        return self::$months[$month];
    }


    private static $longMonths = array(
      "",
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    );

    /**
     * @param int $month
     * @return string
     */
    public static function getLongMonth($month)
    {
        return self::$longMonths[$month];
    }

    public static function out($text)
    {  
        echo date('Y-m-d H:i:s')." > $text\n";
    }

    public static function getGuzzler($concurrent = 20, $usleepTime = 1000)
    {
	    return new Guzzler($concurrent, $usleepTime, "skillq.net", [CURLOPT_SSL_VERIFYHOST => false, CURLOPT_SSL_VERIFYPEER => false, CURLOPT_FRESH_CONNECT => false]);
    }
}
