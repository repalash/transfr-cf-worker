export const indexHTML = `

<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>transfr.one</title>
  <link rel="stylesheet" href="https://stackedit.io/style.css" />
</head>

<body class="stackedit">
<div class="stackedit__html"><h1 id="transfr.one">transfr.one</h1>
  <p>Dead-simple, super-fast, temporary file transfer/piping server, for your browser, code and terminal.</p>
  <h2 id="upload-a-file">Upload a file</h2>
  <h3 id="with-curl">With <code>curl</code></h3>
  <pre class=" language-sh"><code class="prism  language-sh">curl --upload-file ./file.txt https://transfr.one
</code></pre>
  <p>Once the file is uploaded, the endpoint will return the uploaded file URL.</p>
  <pre><code>https://transfr.one/22e3-63401de2/file.txt
</code></pre>
  <h4 id="with-customfilename">With a custom filename</h4>
  <pre class=" language-sh"><code class="prism  language-sh">curl --upload-file ./file.txt https://transfr.one/my-file.txt
</code></pre>
  <h3 id="with-javascripttypescript">With <code>javascript</code>/<code>typescript</code></h3>
  <pre class=" language-javascript"><code class="prism  language-javascript"><span class="token function">fetch</span><span class="token punctuation">(</span><span class="token string">'https://transfr.one/file.txt'</span><span class="token punctuation">,</span> <span class="token punctuation">{</span>
    method<span class="token punctuation">:</span> <span class="token string">'PUT'</span><span class="token punctuation">,</span>
    body<span class="token punctuation">:</span> <span class="token keyword">new</span> <span class="token class-name">File</span><span class="token punctuation">(</span><span class="token punctuation">[</span><span class="token string">'&lt;data goes here&gt;'</span><span class="token punctuation">]</span><span class="token punctuation">,</span> <span class="token string">'file.txt'</span><span class="token punctuation">)</span>
<span class="token punctuation">}</span><span class="token punctuation">)</span><span class="token punctuation">;</span>
</code></pre>
  <h3 id="with-python">With <code>python</code></h3>
  <pre class=" language-python"><code class="prism  language-python"><span class="token keyword">import</span> requests

<span class="token keyword">with</span> <span class="token builtin">open</span><span class="token punctuation">(</span><span class="token string">'file.txt'</span><span class="token punctuation">,</span> <span class="token string">'rb'</span><span class="token punctuation">)</span> <span class="token keyword">as</span> f<span class="token punctuation">:</span>
    data <span class="token operator">=</span> f<span class="token punctuation">.</span>read<span class="token punctuation">(</span><span class="token punctuation">)</span>

response <span class="token operator">=</span> requests<span class="token punctuation">.</span>put<span class="token punctuation">(</span><span class="token string">'https://transfr.one/file.txt'</span><span class="token punctuation">,</span> data<span class="token operator">=</span>data<span class="token punctuation">)</span>
</code></pre>
  <h2 id="download-a-file">Download a file</h2>
  <p>The file can simply be downloaded with the link returned from the endpoint. The link can be opened in a web browser to download the file, alternatively:</p>
  <h3 id="with-curl-1">With <code>curl</code></h3>
  <pre><code>curl -L https://transfr.one/22e3-63401de2/file.txt &gt; file.txt
</code></pre>
  <h3 id="with-javascripttypescript-1">With <code>javascript</code>/<code>typescript</code></h3>
  <pre class=" language-javascript"><code class="prism  language-javascript"><span class="token function">fetch</span><span class="token punctuation">(</span><span class="token string">'https://transfr.one/22e3-63401de2/file.txt'</span><span class="token punctuation">)</span><span class="token punctuation">;</span>
</code></pre>
  <h3 id="with-python-1">With <code>python</code></h3>
  <pre class=" language-python"><code class="prism  language-python"><span class="token keyword">import</span> requests

response <span class="token operator">=</span> requests<span class="token punctuation">.</span>get<span class="token punctuation">(</span><span class="token string">'https://transfr.one/22e3-63401de2/file.txt'</span><span class="token punctuation">)</span>
</code></pre>
  <h2 id="notes">Notes</h2>
  <ul>
    <li>Files are automatically deleted after <code>24 hours</code>.</li>
    <li>Max file upload size is <code>20MB</code>.</li>
    <li>This is a free service, please try not to abuse.</li>
    <li>Powered by Cloudflare Workers. Check out the source code to host your own: <a href="https://github.com/repalash/transfr-cf-worker">https://github.com/repalash/transfr-cf-worker</a></li>
  </ul>
</div>
</body>

</html>


`
