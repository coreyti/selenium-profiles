What is this?
--------------------------------------------------------------------------------

The idea is to collect a number of pre-configured Firefox profile templates for
use with Selenium.  That is, templates which:

  * Are easy to enable
  * Do not cause Selenium/Firefox to complain or behave oddly
    (e.g., no "New Add-on" popup at Firefox launch)
  * Include additional Firefox extensions for use during test runs
    (e.g., Firebug)


Usage
--------------------------------------------------------------------------------

This might get you going (given a Rails project):

    $ cd $RAILS_ROOT # (you get the idea)
    $ git submodule add git://github.com/coreyti/selenium-profiles.git ./vendor/selenium-profiles
    $ ln -s ./vendor/selenium-profiles/firefox-3.0_A ./.firefox
    $ selenium-rc -log ./log/selenium.log -firefoxProfileTemplate ./.firefox > /dev/null 2>&1 &

Enjoy a nice cup of Selenium with Firebug-enabled Firefox!

Note: If you are using selenium-rc and selenium-client gems and have experienced
sqlite3 version conflicts on OS X 10.6.x, take a look at upgrading to:

  * selenium-rc version 2.2.0
  * selenium-client version 1.2.18

The issues seems to be fixed and no longer requires hacking your Firefox.app to
remove libsqlite3.dylib (checked against Firefox 3.5.7).  Of course, if you're
using Webrat or similar, you're still out of luck... the current version has a
hard-coded dependency on earlier selenium-rc.


Package Contents
--------------------------------------------------------------------------------

  * All packages:
    * Add-ons from the Selenium-bundled profile template
      (e.g., DocumentReadyState)
  * firefox-3.0_A
    * firebug 1.4.3
  * firefox-3.5_A
    * firebug 1.5.0
