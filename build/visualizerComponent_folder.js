class CVisualizer extends HTMLElement { // Declaring a class based on a html element. Keep in mind that our c visualizer block inherits all standard html properties. (for example div and span)
    constructor() { super(); } // default constructor, we call super() to make sure everything inside the original html is initialized.
  
    // Called automatically when the element is inserted into the DOM ()
    // note this function is async, meaning that the browser can pause and draw other things and dont have to wait for this function to finish drawing.
    async connectedCallback() {
      // 1) Read and validate the "example" attribute (must be a positive integer)
      const exampleStr = (this.getAttribute("example") || "").trim();
      const isInteractive = this.hasAttribute("interactive"); // check for interactive attribute
      if (!/^\d+$/.test(exampleStr)) { 
        /**
         * This throws an error if the example is not a positive integer.
         * ! - not
         * / - marks start of a JS regular expression
         * ^ - start of a string
         * \d+ - one or more digits
         * $ - end of a string
         * / - end of the JS regular expression
         * 
         * This expression evaluates to true if the input contains anything other than numbers.
         */
        this.innerHTML = `<p style="color:red;">❌ Error: &lt;c-visualizer&gt; requires a valid example number (positive integer).</p>`;
        console.error("[c-visualizer] Invalid 'example':", exampleStr);
        return;
      }
  
      // 2) Build the trace URL based on current page path
      let relPath = location.pathname.replace(/^\//, "").replace(/\.[^/.]+$/, "");
      if (relPath.endsWith("/")) relPath += "index";
      const parts  = relPath.split("/");
      const folder = parts.length > 1 ? parts[parts.length - 2] : "";
      const page   = parts[parts.length - 1];
      const traceUrl = `/trace/${folder}/${page}/example${exampleStr}/trace.json`; // find the trace.json file
  
      // 3) Read inline JSON (annotations + folds) scoped to this custom element only
      let annotations = {};
      let folds = [];
      const inlineEl = this.querySelector('script[type="application/json"][data-kind="annotation"]'); // find annotations within the <c-visualizer> block
      if (inlineEl) {
        try {
          const parsed = JSON.parse((inlineEl.textContent || "").trim()); // parse inline annotations
          annotations = parsed.annotation || {};
          // keep only valid ranges: 1-based lines, end > start
          folds = (parsed.folds || []).filter(
            it => it && Number.isFinite(it.start) && Number.isFinite(it.end) && it.end > it.start
          );
        } catch (e) {
          console.warn("[annotation] Inline JSON parsing failed:", e);
        }
      }

      // 4) extract c code from markdown
      let rawCode = "";
      if (isInteractive) {
        const tempDiv = document.createElement("div");
        tempDiv.innerHTML = this.innerHTML;
        const scriptTag = tempDiv.querySelector('script');
        if (scriptTag) scriptTag.remove();
        rawCode = tempDiv.textContent.trim();
      }
  
      // 5) Create a unique container and show a temporary placeholder
      const divId = `vis-${relPath.replace(/\//g, "-")}-ex${exampleStr}-${Math.floor(Math.random() * 100000)}`; // generates a unique id for each div in the textbook

      // display different placeholders depending on if its interactive or not
      if (isInteractive) {
        this.innerHTML = `
          <div class="interactive-c-visualizer-container" style="margin-bottom: 20px; border: 1px solid #ccc; padding: 15px; border-radius: 4px;">
            <div style="margin-bottom: 10px;">
              <strong style="display: block; margin-bottom: 5px;">Editable C Workspace (Example ${exampleStr}):</strong>
              <textarea id="edit-${divId}" style="width: 100%; height: 180px; font-family: monospace; padding: 10px; box-sizing: border-box; resize: vertical;">${rawCode}</textarea>
            </div>
            <div style="margin-bottom: 15px;">
              <button id="btn-${divId}" style="padding: 6px 12px; cursor: pointer;">Compile & Run</button>
              <span id="status-${divId}" style="margin-left: 10px; font-size: 0.9em; color: #555;"></span>
            </div>
            <div id="${divId}">Loading default trace...</div>
          </div>
        `;
      } else {
        this.innerHTML = `<div id="${divId}">Loading trace...</div>`;
      }

      const rootEl = document.getElementById(divId);

  
      // 6) Attach instance-private data to this container
      rootEl.__stepNotes = annotations;
      rootEl.__folds = folds;

      // 7) Initialize the ExecutionVisualizer (pass annotations directly)
      const lang = this.getAttribute("lang") || "c";
      const renderViz = (traceData) => {
        rootEl.innerHTML = ""; // wipe

        const viz = new window.ExecutionVisualizer(divId, trace, {
          embeddedMode: true,
          lang,    
          codeDivWidth: 470,
        });

        if (typeof window.attachHighlighter === 'function') {
          window.attachHighlighter(viz);
        }

        // Optionally keep a handle for debugging (still instance-private)
        rootEl.__viz = viz;

        // Apply code folding for this instance on the next frame
        requestAnimationFrame(() => {
          // expects your applyCodeFolding(rootEl, folds) to act only within rootEl
          window.applyCodeFolding?.(rootEl, folds);
          if (typeof window.highlightCodeIn === 'function') {
            window.highlightCodeIn(rootEl);
          }
        });
      };

      // 6) Fetch the execution trace JSON
      try {
        const resp = await fetch(traceUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        baselineTrace = await resp.json();
        renderViz(baselineTrace);
      } catch (err) {
        if (isInteractive) {
          rootEl.innerHTML = `<p style="color:red;">Cannot fetch default trace</p>`;
        } else {
          this.innerHTML = `<p style="color:red;">Cannot load ${traceUrl}</p>`;
          console.error("[c-visualizer] Trace failed", err);
          return;
        }
      }

      // 
      if (isInteractive) {
        const btn = document.getElementById(`btn-${divId}`);
        const editor = document.getElementById(`edit-${divId}`);
        const status = document.getElementById(`status-${divId}`);

        btn.addEventListener("click", async () => {
          const userCode = editor.value.trim();
          if (!userCode) {
            status.textContent = "Code workspace cannot be empty.";
            return;
          }

          // Lock interactive controls during active transmission network phase
          btn.disabled = true;
          status.textContent = "Compiling and tracing via backend proxy...";
          rootEl.innerHTML = `<div style="padding: 20px; font-style: italic; color: #666;">Generating fresh execution trace...</div>`;

          try {
            const response = await fetch("/.netlify/functions/proxy-trace", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: userCode })
            });

            if (!response.ok) throw new Error(`Server status ${response.status}`);
            
            const freshTraceData = await response.json();
            
            // Check if backend compiler compilation failed
            if (freshTraceData.code_error) {
              status.textContent = "Compilation Error";
              rootEl.innerHTML = `
                <div style="border: 1px solid red; background: #fff5f5; padding: 15px; font-family: monospace; white-space: pre-wrap; color: red;">${freshTraceData.code_error}</div>
              `;
            } else {
              status.textContent = "Success!";
              renderViz(freshTraceData);
            }

          } catch (networkError) {
            console.error("Tracing failed:", networkError);
            status.textContent = "Connection failed. Check server status";
            rootEl.innerHTML = `<p style="color:red;">Failed to retrieve dynamic trace data.</p>`;
          } finally {
            // Unlock control switches
            btn.disabled = false;
          }
        });
      }
      
    }
  }
  
  // Define the custom element once 
  // This effectively links the <c-visualizer> tag with this js class
  if (!customElements.get("c-visualizer")) {
    customElements.define("c-visualizer", CVisualizer);
  }