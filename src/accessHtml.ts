export const indexHTML = `
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>transfr.one</title>
  <link rel="stylesheet" href="https://stackedit.io/style.css" />
  <style>
      #transfr_one {
          margin-bottom: 2rem;
      }
      .if_encrypted{
          display: ENCRYPTED_DISPLAY;
      }
      .if_not_encrypted{
          display: NOT_ENCRYPTED_DISPLAY;
      }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/openpgp@5.10.2/dist/openpgp.min.js"></script>
  <script type="module">
    function promptPassphrase() {
      let passphrase = "";
      let trial = 0;
      while (trial < 3) {
        passphrase = prompt("Enter passphrase to encrypt file with");
        if (passphrase === null) return null;
        if (passphrase.length < 4) alert("Passphrase must be at least 4 characters long.");
        else return passphrase;
        trial++;
      }
      alert("You can turn off encryption by clicking the 🔐 button.");
      return null;
    }

    document.addEventListener("DOMContentLoaded", () => {
      const dropzoneResult = document.getElementById("dropzone-result");

      // dropzoneResult.addEventListener('click', (e)=>{
      //   e.preventDefault();
      //   e.stopPropagation();
      // })
      // dropzoneResult.addEventListener('pointerdown', (e)=>{
      //   e.preventDefault();
      //   e.stopPropagation();
      // })

    });
  </script>
</head>

<body class="stackedit">
<div class="stackedit__html"><h2 id="transfr_one">FILE_NAME (FILE_SIZE bytes)</h2>
<!--  <p>Dead-simple, encrypted, super-fast, temporary file transfer/piping server, for your browser, code and terminal.</p>-->
<!--  <p>Someone has shared a file with you: </p>-->
  <span class="if_encrypted">This file has been encrypted by the sender</span>
  <p>
    <a href="FILE_LINK_RAW" class="main-link if_encrypted">Download and Decrypt file</a>
    <br>
    <a href="FILE_LINK_RAW" class="main-link">Download <span class="if_encrypted">Raw</span> file</a>
    <br>
  </p>

  <p>The file can simply be downloaded with the link above or in terminal/code.</p>
  <h3 id="with-curl-1">With <code>curl</code></h3>
  <pre class="if_encrypted"><code>curl -L FILE_LINK &gt; FILE_NAME | gpg --pinentry-mode loopback -d -o FILE_NAME_RAW 
</code></pre>
  <pre class="if_not_encrypted"><code>curl -L FILE_LINK &gt; FILE_NAME
</code></pre>
  <h3 id="with-javascripttypescript-1">With <code>javascript</code>/<code>typescript</code></h3>
  <pre class=" language-javascript"><code class="prism  language-javascript"><span
    class="token function">fetch</span><span class="token punctuation">(</span><span class="token string">'FILE_LINK'</span><span
    class="token punctuation">)</span><span class="token punctuation">;</span>
</code></pre>
  <h3 id="with-python-1">With <code>python</code></h3>
  <pre class=" language-python"><code class="prism  language-python"><span class="token keyword">import</span> requests

response <span class="token operator">=</span> requests<span class="token punctuation">.</span>get<span
      class="token punctuation">(</span><span
      class="token string">'FILE_LINK'</span><span class="token punctuation">)</span>
</code></pre>
  <h2 id="notes">Notes</h2>
  <ul>
    <li><a href="https://transfr.one">transfr.one</a> is a simple, encrypted, super-fast, temporary file transfer/piping server, for your browser, code and terminal.</li>
    <li>Files are automatically deleted after <code>24 hours</code>.</li>
    <li>Max file upload size is <code>20MB</code>.</li>
    <li>This is a free service, please try not to abuse.</li>
    <li>Powered by Cloudflare Workers.
      Check out the source code and host your own transfr worker: <a
      href="https://github.com/repalash/transfr-cf-worker">https://github.com/repalash/transfr-cf-worker</a></li>
  </ul>
</div>
</body>

</html>

`
