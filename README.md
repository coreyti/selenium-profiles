What is this?
--------------------------------------------------------------------------------

TODO

In the meantime, the idea is to collect a number of pre-configured Firefox
profile templates for use with Selenium.  That is, templates that:

  * Are easy to enable
  * Do not cause Selenium/Firefox to complain or behave oddly
    (e.g., no "New Add-on" popup at Firefox launch)
  * Include additional Firefox extensions for use during test runs
    (e.g., Firebug)


Usage
--------------------------------------------------------------------------------

TODO

For now, some ideas to get you going (given a Rails project):

    $ cd $RAILS_ROOT # (you get the idea)
    $ git submodule add git://github.com/coreyti/selenium-profiles.git ./vendor/selenium-profiles
    $ ln -s ./vendor/selenium-profiles/firefox-3.0_A ./.firefox
    $ selenium-rc -log ./log/selenium.log -firefoxProfileTemplate ./.firefox > /dev/null 2>&1 &

Enjoy a nice cup of Selenium with Firebug-enabled Firefox!


Package Contents
--------------------------------------------------------------------------------

  * All packages:
    * Add-ons from the Selenium-bundled profile template
      (e.g., DocumentReadyState)
  * firefox-3.0A
    * firebug 1.4.3
