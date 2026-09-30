{{- define "shopmesh.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: {{ .Chart.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- /* Public hostname for a route: <subdomain>.<gateway.domain> */}}
{{- define "shopmesh.host" -}}
{{- printf "%s.%s" .sub .root.Values.gateway.domain -}}
{{- end -}}
