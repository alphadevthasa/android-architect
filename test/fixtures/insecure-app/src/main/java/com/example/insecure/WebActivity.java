package com.example.insecure;

import android.app.Activity;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

public class WebActivity extends Activity {
    private static final String TAG = "WebActivity";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String token = state == null ? "" : state.getString("token");
        WebView web = new WebView(this);
        web.addJavascriptInterface(new Object(), "bridge");
        Log.d(TAG, "token=" + token);
        Log.d(TAG, "loaded");
    }
}
