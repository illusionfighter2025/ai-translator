// AI Translator landing page interactions
(function () {
  "use strict";

  // Sticky nav shadow
  var nav = document.getElementById("nav");
  function onScroll() {
    if (window.scrollY > 24) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mobile menu
  var toggle = document.getElementById("navToggle");
  var links = document.getElementById("navLinks");
  toggle.addEventListener("click", function () {
    toggle.classList.toggle("open");
    links.classList.toggle("open");
  });
  Array.prototype.forEach.call(links.querySelectorAll("a"), function (a) {
    a.addEventListener("click", function () {
      toggle.classList.remove("open");
      links.classList.remove("open");
    });
  });

  // Reveal on scroll
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  // Smooth close for FAQ <details> accordion (only one open)
  var faqs = document.querySelectorAll(".faq-item");
  Array.prototype.forEach.call(faqs, function (item) {
    item.addEventListener("toggle", function () {
      if (item.open) {
        Array.prototype.forEach.call(faqs, function (other) {
          if (other !== item) other.open = false;
        });
      }
    });
  });
})();
