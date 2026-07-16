class CVisualizer extends HTMLElement { 
  constructor() { super(); } 

  async connectedCallback() {
    // 1) Read and validate the "example" attribute
    const exampleStr = (this.getAttribute("example") || "").trim();
    const isInteractive = this.hasAttribute("interactive");
    if (!/^\d+$/.test(exampleStr)) { 
      this.innerHTML = `<p style="color:red;">❌ Error: &lt;c-visualizer&gt; requires a valid example number.</p>`;
      console.error("[c-visualizer] Invalid 'example':", exampleStr);
      return;
    }

    // 2) Build the trace URL based on current page path
    let relPath = location.pathname.replace(/^\//, "").replace(/\.[^/.]+$/, "");
    if (relPath.endsWith("/")) relPath += "index";
    const parts  = relPath.split("/");
    const folder = parts.length > 1 ? parts[parts.length - 2] : "";
    const page   = parts[parts.length - 1];
    const traceUrl = `/trace/${folder}/${page}/example${exampleStr}/trace.json`; 

    // 3) Read inline JSON (annotations + folds)
    let annotations = {};
    let folds = [];
    const inlineEl = this.querySelector('script[type="application/json"][data-kind="annotation"]'); 
    if (inlineEl) {
      try {
        const parsed = JSON.parse((inlineEl.textContent || "").trim()); 
        annotations = parsed.annotation || {};
        folds = (parsed.folds || []).filter(
          it => it && Number.isFinite(it.start) && Number.isFinite(it.end) && it.end > it.start
        );
      } catch (e) {
        console.warn("[annotation] Inline JSON parsing failed:", e);
      }
    }

    // 4) Extract C code from markdown (Do NOT query the editor here!)
    let originalCode = "";
    if (isInteractive) {
      const tempDiv = document.createElement("div");
      tempDiv.innerHTML = this.innerHTML;
      const scriptTag = tempDiv.querySelector('script');
      if (scriptTag) scriptTag.remove();

      const copyButtons = tempDiv.querySelectorAll('.copybtn, .copybutton');
      copyButtons.forEach(btn => btn.remove());

      originalCode = tempDiv.textContent.trim();
    }

    // 5) Create a unique container ID
    const divId = `vis-${relPath.replace(/\//g, "-")}-ex${exampleStr}-${Math.floor(Math.random() * 100000)}`; 

    // Inject the new State Machine HTML layout
    if (isInteractive) {
      this.innerHTML = `
        <div class="c-visualizer-wrapper" style="border: 1px solid #ccc; padding: 15px; border-radius: 4px; margin-bottom: 20px;">
          <div class="toolbar" style="margin-bottom: 15px;">
            <button id="action-btn-${divId}" style="padding: 6px 12px; cursor: pointer;">Edit Code</button>
          </div>

          <div id="visualizer-container-${divId}" style="display: block;">
            <div id="${divId}">Loading default trace...</div>
          </div>

          <div id="editor-container-${divId}" style="display: none;">
            <textarea id="code-editor-${divId}" style="width: 100%; height: 250px; font-family: monospace; padding: 10px; box-sizing: border-box; resize: vertical;">${originalCode}</textarea>
          </div>
        </div>
      `;
    } else {
      this.innerHTML = `<div id="${divId}">Loading trace...</div>`;
    }

    const rootEl = document.getElementById(divId);

    // 6) Attach instance-private data to this container
    rootEl.__stepNotes = annotations;
    rootEl.__folds = folds;

    // 7) Initialize the ExecutionVisualizer locally
    const lang = this.getAttribute("lang") || "c";
    const renderViz = (traceData) => {
      rootEl.innerHTML = ""; // wipe previous content

      const viz = new window.ExecutionVisualizer(divId, traceData, {
        embeddedMode: true,
        lang,    
        codeDivWidth: 470,
      });

      if (typeof window.attachHighlighter === 'function') {
        window.attachHighlighter(viz);
      }

      rootEl.__viz = viz;

      requestAnimationFrame(() => {
        window.applyCodeFolding?.(rootEl, folds);
        if (typeof window.highlightCodeIn === 'function') {
          window.highlightCodeIn(rootEl);
        }
      });
    };

    // 8) Fetch the baseline execution trace JSON
    try {
      const resp = await fetch(traceUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const baselineTrace = await resp.json();
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

    // 9) The Toggle & Compile Listener
    if (isInteractive) {
      // Query the elements using our unique ID tags so multiple widgets don't clash!
      const actionBtn = this.querySelector(`#action-btn-${divId}`);
      const visContainer = this.querySelector(`#visualizer-container-${divId}`);
      const editContainer = this.querySelector(`#editor-container-${divId}`);
      const textArea = this.querySelector(`#code-editor-${divId}`);

      const editor = window.CodeMirror.fromTextArea(textArea, {
        mode: "text/x-csrc",  // Tells it to use C syntax
        lineNumbers: true,    // Adds line numbers on the left
        indentUnit: 4,        // Sets Tab size to 4 spaces
        indentWithTabs: false,// Uses spaces instead of actual tab characters (better for C)
        viewportMargin: Infinity // Allows the editor to resize dynamically
      });

      // (Optional) CodeMirror sometimes renders weirdly when hidden by default. 
      // This forces it to redraw perfectly when the user clicks "Edit Code"
      const refreshEditor = () => {
        setTimeout(() => editor.refresh(), 10);
      };

      actionBtn.addEventListener('click', async () => {
        
        // PATH A: Switching to Editor
        if (actionBtn.innerText === "Edit Code") {
          visContainer.style.display = 'none';
          editContainer.style.display = 'block';
          actionBtn.innerText = "Compile & Run";

          refreshEditor();
        } 
        
        // PATH B: Compiling & Switching to Visualizer
        else {
          const studentCode = editor.getValue().trim();

          // Dirty Check
          if (studentCode === originalCode) {
            editContainer.style.display = 'none';
            visContainer.style.display = 'block';
            actionBtn.innerText = "Edit Code";
            return; 
          }

          actionBtn.innerText = "Compiling...";
          actionBtn.disabled = true; 

          try {
            const response = await fetch("/.netlify/functions/proxy-trace", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ code: studentCode })
            });

            if (!response.ok) throw new Error("Compilation failed");
            const traceData = await response.json();

            // Feed the proxy data into the local visualizer rendering function!
            renderViz(traceData); 

            originalCode = studentCode;

            editContainer.style.display = 'none';
            visContainer.style.display = 'block';
            actionBtn.innerText = "Edit Code";

          } catch (error) {
            console.error("Proxy error:", error);
            alert("Compilation failed. See console.");
            actionBtn.innerText = "Compile & Run"; 
          } finally {
            actionBtn.disabled = false;
          }
        }
      });
    }
  }
}

if (!customElements.get("c-visualizer")) {
  customElements.define("c-visualizer", CVisualizer);
}