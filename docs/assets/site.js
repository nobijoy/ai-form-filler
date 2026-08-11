(() => {
  const path = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  const page = path === "" || path === "/" ? "index.html" : path;

  document.querySelectorAll("[data-nav]").forEach((link) => {
    const href = (link.getAttribute("href") || "").replace(/^\.\//, "");
    if (href === page || (page === "index.html" && href === "./index.html")) {
      link.setAttribute("aria-current", "page");
    }
  });

  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      });
    });
  }

  if (document.querySelector(".mermaid") && window.mermaid) {
    window.mermaid.initialize({
      startOnLoad: true,
      theme: "neutral",
      securityLevel: "loose",
      flowchart: { curve: "basis" },
    });
  }
})();
