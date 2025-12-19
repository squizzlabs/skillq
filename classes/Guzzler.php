<?php

class Guzzler
{
	private $curl;
	private $handler;
	private $client;
	private $concurrent = 0;
	private $maxConcurrent;
	private $usleep;
	private $lastHeaders = [];
	private $etagTTL = 86400;

	public function __construct($maxConcurrent = 10, $usleep = 100000, $userAgent = 'cvweiss/guzzler/', $curlOptions = [])
	{
		$curlOptions = $curlOptions == [] ? [CURLOPT_FRESH_CONNECT => false] : $curlOptions;

		$this->curl = new \GuzzleHttp\Handler\CurlMultiHandler();
		$this->handler = \GuzzleHttp\HandlerStack::create($this->curl);
		$this->client = new \GuzzleHttp\Client(['curl' => $curlOptions, 'connect_timeout' => 10, 'timeout' => 10, 'handler' => $this->handler, 'headers' => ['User-Agent' => $userAgent]]);
		$this->maxConcurrent = max($maxConcurrent, 1);
		$this->usleep = max(0, min(1000000, (int) $usleep));
	}

	public function tick()
	{
		$ms = microtime(1);
		do {
			$this->curl->tick();
			if ($this->concurrent >= $this->maxConcurrent) usleep(max(1, min(1000000, $this->usleep)));
		} while ($this->concurrent >= $this->maxConcurrent);
		return max(0, microtime(1) - $ms);
	}

	public function finish()
	{
		$ms = microtime(1);
		$this->curl->execute();
		return max(0, microtime(1) - $ms);
	}

	public function inc()
	{
		$this->concurrent++;
	}

	public function dec()
	{
		$this->concurrent--;
	}

	public function call($uri, $fulfilled, $rejected, $params = [], $setup = [], $callType = 'GET', $body = null)
	{
		$this->verifyCallable($fulfilled);
		$this->verifyCallable($rejected);

		while ($this->concurrent >= $this->maxConcurrent) $this->tick();

		$params['uri'] = $uri;
		$params['fulfilled'] = $fulfilled;
		$params['rejected'] = $rejected;
		$params['setup'] = $setup;
		$params['callType'] = $callType;
		$params['body'] = $body;

		$redis = $this->applyEtag($setup, $params);

		$guzzler = $this;
		$request = new \GuzzleHttp\Psr7\Request($callType, $uri, $setup, $body);
		$this->client->sendAsync($request)->then(
				function($response) use (&$guzzler, $fulfilled, &$params, $redis) {
				$guzzler->dec();
				$content = (string) $response->getBody();
				$this->lastHeaders = array_change_key_case($response->getHeaders());
				$this->applyEtagPost($this->lastHeaders, $params['uri'], $redis);
				$fulfilled($guzzler, $params, $content, $response->getHeaders());
				},
				function($connectionException) use (&$guzzler, &$rejected, &$params) {
				$guzzler->dec();
				$response = $connectionException->getResponse();
				$this->lastHeaders = $response == null ? [] : array_change_key_case($response->getHeaders());
				$params['content'] = method_exists($response, "getBody") ? (string) $response->getBody() : "";
				$rejected($guzzler, $params, $connectionException, $response->getHeaders());
				});
		$this->inc();
	}

	protected function applyEtag(&$setup, $params)
	{
		$redis = isset($setup['etag']) ? $setup['etag'] : null;
		if ($redis !== null && $params['callType'] == 'GET') {
			$etag = $redis->get("guzzler:etags:" . $params['uri']);
			if ($etag != "") $setup['If-None-Match'] = $etag;
		}
		unset($setup['etag']);
		return $redis;
	}

	protected function applyEtagPost($headers, $uri, $redis)
	{
		if (isset($headers['etag']) && $redis !== null) {
			$redis->setex("guzzler:etags:$uri", $this->etagTTL, $headers['etag'][0]);
		}
	}

	public function verifyCallable($callable)
	{
		if (!is_callable($callable)) {
			throw new \InvalidArgumentException(print_r($callable, true) . " is not a callable function");
		}
	}

	public function getLastHeaders()
	{
		return $this->lastHeaders;
	}

	public function setEtagTTL($ttl)
	{
		$this->etagTTL = $ttl;
	}
}
